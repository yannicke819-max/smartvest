/**
 * PR #286 — Tests fetch_diag schema + fallback chain ordering.
 *
 * On valide la SHAPE du fetchDiag retourné par simulateRow (via injection
 * d'un EodhdIntradayService mocké) et l'ORDRE de la fallback chain (4 steps
 * dans l'ordre attendu : 5m_range → ticks_range → 1m_range → 5m_default).
 *
 * Le service complet est lourd à instancier (NestJS DI), on contourne via
 * mock direct du eodhd-service. SupabaseService est aussi mocké minimal.
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

// Helper : appelle simulateRow via reflection (private méthode, mais accessible
// via TS bracket notation pour tests). Sinon il faudrait exposer un wrapper.
async function runSim(svc: GainersUserShadowService, args: { symbol: string; assetClass: string; entryPrice: number; createdAt: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (svc as any).simulateRow(args);
}

describe('PR #286 — fetch_diag shape', () => {
  it('populates 4-step fallback chain when all return empty', async () => {
    const callLog: FetchCall[] = [];
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles: [], rawCount: 0, requestedSymbol: '300161.SHE' },
        ticks_range: null,
        getCandles_1m_range: null,
        getCandles_5m_default: { candles: [], rawCount: 0, requestedSymbol: '300161.SHE' },
      },
      callLog,
    });
    const startTs = Math.floor(Date.now() / 1000) - 12 * 3600;  // 12h ago, within retention
    const { fetchDiag } = await runSim(svc, {
      symbol: '300161.SHE',
      assetClass: 'asia_equity',
      entryPrice: 28.42,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag };

    expect(fetchDiag.steps).toHaveLength(4);
    expect(fetchDiag.steps[0].endpoint).toBe('eodhd_getCandles_5m_range');
    expect(fetchDiag.steps[1].endpoint).toBe('eodhd_ticks_5m_range');
    expect(fetchDiag.steps[2].endpoint).toBe('eodhd_getCandles_1m_range');
    expect(fetchDiag.steps[3].endpoint).toBe('eodhd_getCandles_5m_default');
    expect(fetchDiag.selectedStep).toBeNull();
    expect(fetchDiag.outcome).toBe('no_data');
    expect(fetchDiag.steps[0].rangeMode).toBe(true);
    expect(fetchDiag.steps[3].rangeMode).toBe(false);  // default mode
    expect(fetchDiag.steps[0].inputSymbol).toBe('300161.SHE');
  });

  it('stops at step 1 when primary 5m_range returns valid candles', async () => {
    const callLog: FetchCall[] = [];
    const startTs = Math.floor(Date.now() / 1000) - 6 * 3600;
    const validCandle = {
      timestamp: startTs + 600,
      open: 28.42, high: 28.50, low: 28.40, close: 28.48, volume: 1000,
    };
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles: [validCandle], rawCount: 1, requestedSymbol: '300161.SHE' },
      },
      callLog,
    });
    const { fetchDiag, results } = await runSim(svc, {
      symbol: '300161.SHE',
      assetClass: 'asia_equity',
      entryPrice: 28.42,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag; results: Record<string, { outcome: string }> };

    expect(fetchDiag.selectedStep).toBe(0);
    expect(fetchDiag.outcome).toBe('ok');
    expect(fetchDiag.steps).toHaveLength(1);  // chain stopped at step 1
    expect(fetchDiag.forwardCount).toBe(1);
    expect(results.baseline_60m.outcome).toBe('TIME_LIMIT');  // 1 candle, no TP/SL hit
    // Vérif callLog : seul l'endpoint primary a été appelé
    expect(callLog).toEqual([{ endpoint: 'getCandles_5m_range', ticker: '300161.SHE' }]);
  });

  it('falls through to step 3 (1m_range) when 5m_range and ticks return empty', async () => {
    const callLog: FetchCall[] = [];
    const startTs = Math.floor(Date.now() / 1000) - 6 * 3600;
    const validCandle = {
      timestamp: startTs + 300,
      open: 100, high: 102.5, low: 99.5, close: 102.1, volume: 1000,
    };
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles: [], rawCount: 0, requestedSymbol: '013310.KQ' },
        ticks_range: { candles: [], rawCount: 0, requestedSymbol: '013310.KQ' },
        getCandles_1m_range: { candles: [validCandle], rawCount: 1, requestedSymbol: '013310.KQ' },
      },
      callLog,
    });
    const { fetchDiag } = await runSim(svc, {
      symbol: '013310.KQ',
      assetClass: 'asia_equity',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag };

    expect(fetchDiag.selectedStep).toBe(2);  // 0-indexed : step3 → index 2
    expect(fetchDiag.steps).toHaveLength(3);  // stopped at step 3
    expect(fetchDiag.outcome).toBe('ok');
    expect(callLog.map(c => c.endpoint)).toEqual([
      'getCandles_5m_range',
      'ticks_range',
      'getCandles_1m_range',
    ]);
  });

  it('records nulls correctly when EODHD returns mixed null/valid candles', async () => {
    const callLog: FetchCall[] = [];
    const startTs = Math.floor(Date.now() / 1000) - 6 * 3600;
    const svc = buildService({
      candlesByEndpoint: {
        // rawCount=10 mais candles.length=3 (7 candles avec close=null filtrées)
        getCandles_5m_range: {
          candles: [
            { timestamp: startTs + 300, open: 100, high: 101, low: 99.5, close: 100.5, volume: 1000 },
            { timestamp: startTs + 600, open: 100.5, high: 102, low: 100, close: 101, volume: 1500 },
            { timestamp: startTs + 900, open: 101, high: 101.5, low: 100.8, close: 101.2, volume: 800 },
          ],
          rawCount: 10,
          requestedSymbol: '300161.SHE',
        },
      },
      callLog,
    });
    const { fetchDiag } = await runSim(svc, {
      symbol: '300161.SHE',
      assetClass: 'asia_equity',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag };

    expect(fetchDiag.steps[0].rawCount).toBe(10);
    expect(fetchDiag.steps[0].validClose).toBe(3);
    expect(fetchDiag.steps[0].nulls).toBe(7);
    expect(fetchDiag.steps[0].requestedSymbol).toBe('300161.SHE');
  });

  it('returns precondition error step when entry_price missing', async () => {
    const callLog: FetchCall[] = [];
    const svc = buildService({ candlesByEndpoint: {}, callLog });
    const { fetchDiag } = await runSim(svc, {
      symbol: '300161.SHE',
      assetClass: 'asia_equity',
      entryPrice: 0,
      createdAt: new Date().toISOString(),
    }) as { fetchDiag: FetchDiag };
    expect(fetchDiag.outcome).toBe('error');
    expect(fetchDiag.steps[0].error).toBe('no_entry_price');
    expect(callLog).toHaveLength(0);  // pas de fetch tenté
  });

  it('PR #287 — populates firstCandleTs/lastCandleTs + forwardCountAfterFilter per step', async () => {
    const callLog: FetchCall[] = [];
    const startTs = Math.floor(Date.now() / 1000) - 6 * 3600;
    // 3 candles : 1 avant startTs (rejected by filter) + 2 après
    const candles = [
      { timestamp: startTs - 600, open: 100, high: 100, low: 99.5, close: 99.8, volume: 100 },
      { timestamp: startTs + 300, open: 100, high: 101, low: 99.5, close: 100.5, volume: 1000 },
      { timestamp: startTs + 900, open: 100.5, high: 102, low: 100, close: 101.5, volume: 1500 },
    ];
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles, rawCount: 3, requestedSymbol: '300161.SHE' },
      },
      callLog,
    });
    const { fetchDiag } = await runSim(svc, {
      symbol: '300161.SHE',
      assetClass: 'asia_equity',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag };

    expect(fetchDiag.steps[0].firstCandleTs).toBe(startTs - 600);
    expect(fetchDiag.steps[0].lastCandleTs).toBe(startTs + 900);
    expect(fetchDiag.steps[0].forwardCountAfterFilter).toBe(2); // 2/3 candles >= startTs
    // Top-level startTs/cutoffTs60 capturés
    expect(fetchDiag.startTs).toBe(startTs);
    expect(fetchDiag.cutoffTs60).toBe(startTs + 60 * 60);
  });

  it('PR #287 — requestedSymbol falls back to inputSymbol when call returns null', async () => {
    const callLog: FetchCall[] = [];
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: null,  // EODHD returns null → no series object
        ticks_range: null,
        getCandles_1m_range: null,
        getCandles_5m_default: null,
      },
      callLog,
    });
    const { fetchDiag } = await runSim(svc, {
      symbol: '300303.SHE',
      assetClass: 'asia_equity',
      entryPrice: 28.42,
      createdAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag };

    // PR #287 — Avant : requestedSymbol=null sur tous les steps quand call=null.
    // Maintenant : fallback à inputSymbol → permet de voir en SQL le ticker tenté.
    expect(fetchDiag.steps).toHaveLength(4);
    for (const step of fetchDiag.steps) {
      expect(step.requestedSymbol).toBe('300303.SHE');
      expect(step.inputSymbol).toBe('300303.SHE');
      expect(step.firstCandleTs).toBeUndefined();  // pas de candles → pas de timestamps
      expect(step.lastCandleTs).toBeUndefined();
    }
  });

  it('skips crypto with explicit error step (Binance not yet wired)', async () => {
    const callLog: FetchCall[] = [];
    const svc = buildService({ candlesByEndpoint: {}, callLog });
    const { fetchDiag } = await runSim(svc, {
      symbol: 'BTCUSDT',
      assetClass: 'crypto_major',
      entryPrice: 60000,
      createdAt: new Date().toISOString(),
    }) as { fetchDiag: FetchDiag };
    expect(fetchDiag.outcome).toBe('error');
    expect(fetchDiag.steps[0].error).toBe('crypto_not_supported');
    expect(callLog).toHaveLength(0);
  });
});
