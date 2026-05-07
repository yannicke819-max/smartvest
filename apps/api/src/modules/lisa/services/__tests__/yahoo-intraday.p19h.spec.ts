/**
 * P19h — Tests pour le circuit breaker YahooIntradayService.
 *
 * Comportement attendu :
 *  - 1er crash provider (5xx/429/403/timeout/parse) → open circuit + 1 WARN
 *  - Pendant cooldown : getCandles return null silently (no fetch, no log spam)
 *  - Backoff exponentiel : 60s → 120s → 240s → 480s → ... cap 1800s (30min, PR #268)
 *  - Reset auto sur succès d'une probe après cooldown
 *  - 404 ticker non-trouvé → NE TRIP PAS le breaker (provider OK, ticker KO)
 *  - chart.error API → idem (symbol not found)
 *
 * Tests utilisent jest.useFakeTimers() pour contrôler le wall-clock sans
 * attendre 60s+ par test.
 */

import { Logger } from '@nestjs/common';
import { YahooIntradayService } from '../yahoo-intraday.service';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

beforeEach(() => {
  warnSpy.mockClear();
  logSpy.mockClear();
});

function mockHttp(status: number, body: any = {}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => '',
  } as any);
}

function mockOk(closes: (number | null)[] = [180, 181, 182]) {
  const baseTs = 1761830400;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      chart: {
        result: [{
          meta: { symbol: 'AAPL' },
          timestamp: closes.map((_, i) => baseTs + i * 300),
          indicators: { quote: [{ close: closes, open: closes, high: closes, low: closes, volume: closes.map(() => 1000) }] },
        }],
        error: null,
      },
    }),
    text: async () => '',
  } as any);
}

describe('YahooIntradayService — P19h circuit breaker', () => {
  it('initial state is closed, openCount=0', () => {
    const svc = new YahooIntradayService();
    const status = svc.getCircuitStatus();
    expect(status.state).toBe('closed');
    expect(status.openCount).toBe(0);
    expect(status.consecutiveFailures).toBe(0);
  });

  it('successful fetch keeps circuit closed', async () => {
    mockOk();
    const svc = new YahooIntradayService();
    const result = await svc.getCandles('AAPL.US', '5m');
    expect(result).not.toBeNull();
    expect(svc.getCircuitStatus().state).toBe('closed');
    expect(svc.getCircuitStatus().consecutiveFailures).toBe(0);
  });

  it('HTTP 429 trips circuit, emits ONE warn', async () => {
    mockHttp(429);
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m');
    expect(svc.getCircuitStatus().state).toBe('open');
    expect(svc.getCircuitStatus().openCount).toBe(1);

    const breakerWarn = warnSpy.mock.calls.filter((c) => String(c[0]).includes('[yahoo:circuit]'));
    expect(breakerWarn.length).toBe(1);
    expect(String(breakerWarn[0][0])).toContain('HTTP 429');
    expect(String(breakerWarn[0][0])).toContain('60s');
  });

  it('HTTP 403 trips circuit', async () => {
    mockHttp(403);
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m');
    expect(svc.getCircuitStatus().state).toBe('open');
  });

  it('HTTP 500/502/503 trips circuit', async () => {
    mockHttp(503);
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m');
    expect(svc.getCircuitStatus().state).toBe('open');
  });

  it('HTTP 404 (ticker not found) does NOT trip circuit', async () => {
    mockHttp(404);
    const svc = new YahooIntradayService();
    await svc.getCandles('FAKEXYZ.US', '5m');
    expect(svc.getCircuitStatus().state).toBe('closed');
    expect(svc.getCircuitStatus().consecutiveFailures).toBe(0);
    const breakerWarn = warnSpy.mock.calls.filter((c) => String(c[0]).includes('[yahoo:circuit]'));
    expect(breakerWarn.length).toBe(0);
  });

  it('chart.error in response (symbol not found) does NOT trip circuit', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ chart: { result: null, error: { code: 'Not Found', description: 'No data' } } }),
      text: async () => '',
    } as any);
    const svc = new YahooIntradayService();
    await svc.getCandles('FAKE.US', '5m');
    expect(svc.getCircuitStatus().state).toBe('closed');
  });

  it('network error trips circuit', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m');
    expect(svc.getCircuitStatus().state).toBe('open');
  });

  it('during cooldown, getCandles returns null without calling fetch', async () => {
    mockHttp(429);
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m'); // trips circuit
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);

    // Subsequent calls during cooldown : no fetch, no extra warn
    warnSpy.mockClear();
    const r2 = await svc.getCandles('AAPL.US', '5m');
    const r3 = await svc.getCandles('NVDA.US', '5m');
    expect(r2).toBeNull();
    expect(r3).toBeNull();
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1); // still 1
    expect(warnSpy.mock.calls.length).toBe(0); // no spam
  });

  it('exponential backoff : 60s → 120s → 240s → 480s (cap 1800s/30min)', async () => {
    jest.useFakeTimers();
    mockHttp(503);
    const svc = new YahooIntradayService();

    // Failure 1 → 60s
    await svc.getCandles('AAPL.US', '5m');
    expect(warnSpy.mock.calls.find((c) => String(c[0]).includes('60s'))).toBeDefined();

    // Advance past cooldown 1, failure 2 → 120s
    jest.advanceTimersByTime(61_000);
    warnSpy.mockClear();
    await svc.getCandles('AAPL.US', '5m');
    expect(warnSpy.mock.calls.find((c) => String(c[0]).includes('120s'))).toBeDefined();

    // Advance past cooldown 2, failure 3 → 240s
    jest.advanceTimersByTime(121_000);
    warnSpy.mockClear();
    await svc.getCandles('AAPL.US', '5m');
    expect(warnSpy.mock.calls.find((c) => String(c[0]).includes('240s'))).toBeDefined();

    // Advance past cooldown 3, failure 4 → 480s (cap 1800s/30min raised in PR #268)
    jest.advanceTimersByTime(241_000);
    warnSpy.mockClear();
    await svc.getCandles('AAPL.US', '5m');
    expect(warnSpy.mock.calls.find((c) => String(c[0]).includes('480s'))).toBeDefined();
  });

  it('reset on success after cooldown: probe succeeds → circuit closes + LOG line', async () => {
    jest.useFakeTimers();
    mockHttp(503);
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m'); // trips
    expect(svc.getCircuitStatus().state).toBe('open');
    expect(svc.getCircuitStatus().consecutiveFailures).toBe(1);

    // Pass cooldown
    jest.advanceTimersByTime(61_000);
    // Yahoo recovers
    mockOk();
    logSpy.mockClear();
    const result = await svc.getCandles('AAPL.US', '5m');

    expect(result).not.toBeNull();
    expect(svc.getCircuitStatus().state).toBe('closed');
    expect(svc.getCircuitStatus().consecutiveFailures).toBe(0);

    const reEnabledLog = logSpy.mock.calls.find((c) => String(c[0]).includes('[yahoo:circuit] provider re-enabled'));
    expect(reEnabledLog).toBeDefined();
  });

  it('resetCircuit() admin helper closes immediately', async () => {
    mockHttp(503);
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m');
    expect(svc.getCircuitStatus().state).toBe('open');

    svc.resetCircuit();
    expect(svc.getCircuitStatus().state).toBe('closed');
    expect(svc.getCircuitStatus().consecutiveFailures).toBe(0);
  });

  it('mixed failures + 404s : only failures count toward the breaker', async () => {
    const svc = new YahooIntradayService();
    // 1) 404 → no trip
    mockHttp(404);
    await svc.getCandles('FAKE.US', '5m');
    expect(svc.getCircuitStatus().state).toBe('closed');

    // 2) 429 → trips
    mockHttp(429);
    await svc.getCandles('AAPL.US', '5m');
    expect(svc.getCircuitStatus().state).toBe('open');
    expect(svc.getCircuitStatus().consecutiveFailures).toBe(1);
  });

  it('openCount is cumulative across closing/reopening cycles', async () => {
    jest.useFakeTimers();
    mockHttp(429);
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m');
    expect(svc.getCircuitStatus().openCount).toBe(1);

    // Recover, then re-fail
    jest.advanceTimersByTime(61_000);
    mockOk();
    await svc.getCandles('AAPL.US', '5m');
    expect(svc.getCircuitStatus().state).toBe('closed');

    mockHttp(429);
    await svc.getCandles('AAPL.US', '5m');
    expect(svc.getCircuitStatus().state).toBe('open');
    expect(svc.getCircuitStatus().openCount).toBe(2);
  });
});
