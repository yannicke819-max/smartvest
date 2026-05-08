/**
 * PR #291 — Tests freshness diagnostic (age_ms + candle_freshness_s).
 *
 * Bug observé prod 08/05/2026 18:01 UTC : tous les rows US/Asia ont
 * forward=0 avec lastCandleTs ~22h dans le passé. Signe que EODHD
 * retourne des candles très stales. Cette PR ajoute la latence dans
 * fetch_diag pour pouvoir SQL-query "candles freshness par ticker".
 */
import { GainersUserShadowService, type FetchDiag } from '../services/gainers-user-shadow.service';

type FetchCall = { endpoint: string; ticker: string };

function buildService(opts: {
  candlesByEndpoint: Record<string, { candles: Array<{ timestamp: number; high: number; low: number; close: number; open?: number; volume?: number }>; rawCount?: number; requestedSymbol?: string } | null>;
  callLog: FetchCall[];
}): GainersUserShadowService {
  const eodhdMock = {
    getCandles: jest.fn(async (ticker: string, interval: string, _count: number, options?: unknown) => {
      const range = options ? '_range' : '_default';
      const key = `getCandles_${interval}${range}`;
      opts.callLog.push({ endpoint: key, ticker });
      return opts.candlesByEndpoint[key] ?? null;
    }),
    getCandlesViaTicks: jest.fn(async (ticker: string, _interval: string, _count: number, _options?: unknown) => {
      opts.callLog.push({ endpoint: 'ticks_range', ticker });
      return opts.candlesByEndpoint['ticks_range'] ?? null;
    }),
  };
  const supabaseMock = {
    getClient: () => ({ from: () => ({ select: () => ({ is: () => ({ lte: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }) }) }),
  };
  return new GainersUserShadowService(supabaseMock as never, eodhdMock as never);
}

async function runSim(svc: GainersUserShadowService, args: { symbol: string; assetClass: string; entryPrice: number; createdAt: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (svc as any).simulateRow(args);
}

describe('PR #291 — freshness diagnostic per step', () => {
  it('populates age_ms + candle_freshness_s when candles returned', async () => {
    const callLog: FetchCall[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const startTs = nowSec - 6 * 3600;
    // Latest candle = 30min in the past = freshness 30min
    const lastCandleTs = nowSec - 30 * 60;
    const candles = [
      { timestamp: lastCandleTs - 600, open: 100, high: 100.5, low: 99.5, close: 100.2, volume: 1000 },
      { timestamp: lastCandleTs, open: 100.2, high: 102, low: 100, close: 101.5, volume: 1500 },
    ];
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles, rawCount: 2, requestedSymbol: 'AAPL.US' },
      },
      callLog,
    });
    const { fetchDiag } = await runSim(svc, {
      symbol: 'AAPL.US',
      assetClass: 'us_equity_large',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag };

    const step1 = fetchDiag.steps[0];
    // age_ms ≈ 30 * 60 * 1000 = 1_800_000 (avec petite marge pour le delay test)
    expect(step1.age_ms).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(step1.age_ms).toBeLessThan(31 * 60 * 1000);
    expect(step1.candle_freshness_s).toBeGreaterThanOrEqual(30 * 60);
    expect(step1.candle_freshness_s).toBeLessThan(31 * 60);
    // Sanity : lastCandleTs doit aussi être présent
    expect(step1.lastCandleTs).toBe(lastCandleTs);
  });

  it('STALE detection — candles 22h old (bug prod observé)', async () => {
    const callLog: FetchCall[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const startTs = nowSec - 60;
    // Candles de la session précédente : 22h dans le passé
    const lastCandleTs = nowSec - 22 * 3600;
    const candles = [
      { timestamp: lastCandleTs, open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
    ];
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles, rawCount: 1, requestedSymbol: 'HRB.US' },
      },
      callLog,
    });
    const { fetchDiag } = await runSim(svc, {
      symbol: 'HRB.US',
      assetClass: 'us_equity_large',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag };

    const step1 = fetchDiag.steps[0];
    // age_ms doit signaler la 22h staleness
    expect(step1.candle_freshness_s).toBeGreaterThan(20 * 3600);  // > 20h
    expect(step1.candle_freshness_s).toBeLessThan(23 * 3600);     // < 23h
    expect(step1.age_ms).toBeGreaterThan(20 * 3600 * 1000);
    // forwardCountAfterFilter = 0 (candle 22h before startTs)
    expect(step1.forwardCountAfterFilter).toBe(0);
  });

  it('age_ms NOT populated when validClose=0 (no candles)', async () => {
    const callLog: FetchCall[] = [];
    const startTs = Math.floor(Date.now() / 1000) - 60;
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles: [], rawCount: 0, requestedSymbol: 'HEG.NSE' },
        ticks_range: null,
        getCandles_1m_range: null,
        getCandles_5m_default: null,
      },
      callLog,
    });
    const { fetchDiag } = await runSim(svc, {
      symbol: 'HEG.NSE',
      assetClass: 'asia_equity',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag };

    // 4 steps tous empty → age_ms undefined partout (sémantique : pas de candle)
    for (const step of fetchDiag.steps) {
      expect(step.age_ms).toBeUndefined();
      expect(step.candle_freshness_s).toBeUndefined();
    }
  });
});
