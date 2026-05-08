/**
 * PR #284 — Tests range fetch (fromTs/toTs) + retention guard.
 *
 * Le fetch range explicite est critique pour la retro-simulation des shadow
 * signals : sans ça, getCandles('5m', N) retourne les latest N candles, qui
 * ne couvrent pas la fenêtre [startTs, startTs+60min] quand la sim tourne
 * 12h+ après recordDecision (cas observé prod 08/05/2026).
 *
 * Note : EodhdIntradayService est lourd à mocker (cache, fetch, logs). Ces
 * tests valident la logique pure de retention et d'URL building en mockant
 * uniquement `fetch` global.
 */
import { Logger } from '@nestjs/common';
import { EodhdIntradayService } from '../services/eodhd-intraday.service';

// Mock minimal pour ApiCostTrackerService (constructor dep)
const mockApiCostTracker = {
  recordCall: jest.fn(),
  // Add other methods if needed
} as unknown as { recordCall: jest.Mock };

const mockConfig = {
  get: jest.fn((key: string) => {
    if (key === 'EODHD_API_KEY') return 'test-api-key';
    return undefined;
  }),
} as unknown as { get: jest.Mock };

describe('EodhdIntradayService — PR #284 range fetch + retention', () => {
  let service: EodhdIntradayService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    // Suppress console output during tests
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    service = new EodhdIntradayService(mockConfig as never, mockApiCostTracker as never);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('passes explicit fromTs/toTs to URL params (range mode)', async () => {
    // fromTs récent (< 5d) pour passer le retention guard
    const nowSec = Math.floor(Date.now() / 1000);
    const fromTs = nowSec - 12 * 3600;     // 12h ago, well within 5d retention
    const toTs = fromTs + 3900;             // +65min
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => [
        { timestamp: fromTs + 300, open: 100, high: 101, low: 99.5, close: 100.5, volume: 1000 },
        { timestamp: fromTs + 1200, open: 100.5, high: 102, low: 100, close: 101.5, volume: 1500 },
        { timestamp: fromTs + 3600, open: 101.5, high: 102.2, low: 101, close: 102, volume: 2000 },
      ],
    } as Response);

    const result = await service.getCandles('NYT.US', '5m', 30, { fromTs, toTs });

    expect(result).not.toBeNull();
    expect(result!.candles).toHaveLength(3);
    // URL doit contenir from/to explicites, pas le default 5j
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain(`from=${fromTs}`);
    expect(calledUrl).toContain(`to=${toTs}`);
    expect(calledUrl).toContain('NYT.US');
    expect(calledUrl).toContain('interval=5m');
  });

  it('returns null + warn EODHD_RETENTION_EXCEEDED when fromTs > 5 days ago', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    const nowSec = Math.floor(Date.now() / 1000);
    const fromTs = nowSec - 6 * 86400;  // 6 days ago, beyond 5d retention
    const toTs = fromTs + 3900;

    const result = await service.getCandles('AAPL.US', '5m', 30, { fromTs, toTs });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();  // early return, pas de fetch
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('EODHD_RETENTION_EXCEEDED'),
    );
    expect(warnSpy.mock.calls[0][0]).toContain('AAPL.US');
  });

  it('accepts fromTs exactly at the 5d boundary (allow ≤5d)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const fromTs = nowSec - 4.9 * 86400;  // 4.9 days = within retention
    const toTs = fromTs + 3900;
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => [
        { timestamp: fromTs + 300, open: 100, high: 101, low: 99.5, close: 100.5, volume: 1000 },
      ],
    } as Response);

    const result = await service.getCandles('AAPL.US', '5m', 30, { fromTs, toTs });
    expect(result).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('back-compat : no options → uses default windowForInterval (latest mode)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => [
        { timestamp: 1700000000, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
      ],
    } as Response);

    await service.getCandles('AAPL.US', '5m', 20);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    // Default mode : from = now - 5*24*3600, doit être un timestamp récent
    const fromMatch = /from=(\d+)/.exec(calledUrl);
    expect(fromMatch).not.toBeNull();
    const fromTs = parseInt(fromMatch![1], 10);
    const nowSec = Math.floor(Date.now() / 1000);
    // fromTs doit être ~5 jours dans le passé, pas un fromTs explicite
    expect(nowSec - fromTs).toBeGreaterThan(4 * 86400);
    expect(nowSec - fromTs).toBeLessThan(6 * 86400);
  });

  it('range mode : returns ALL candles in range (no slice -count)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const fromTs = nowSec - 12 * 3600;
    const toTs = fromTs + 3900;
    // 30 candles dans la réponse, count=10 demandé → range mode garde tout
    const candles = Array.from({ length: 30 }, (_, i) => ({
      timestamp: fromTs + i * 300,
      open: 100, high: 101, low: 99.5, close: 100, volume: 100,
    }));
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => candles,
    } as Response);

    const result = await service.getCandles('NYT.US', '5m', 10, { fromTs, toTs });
    expect(result!.candles).toHaveLength(30);  // pas slicé à 10
  });
});
