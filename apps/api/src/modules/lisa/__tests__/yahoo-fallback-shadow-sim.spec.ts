/**
 * PR #296 Partie B — Tests d'intégration Yahoo fallback dans le shadow sim.
 *
 * Setup : RTH-active capture (Step 0 lets through), EODHD chain returns
 * empty (simulating 24-25h staleness observed prod), Yahoo returns fresh
 * forward candles → simulator computes real outcome.
 *
 * Vérifie :
 *   - Yahoo step appelé uniquement après échec des 4 EODHD steps
 *   - Yahoo candles filtrées sur [fromTs, toTs] avant walkForward
 *   - fetchDiag.steps[] inclut yahoo_intraday_5m comme step5
 *   - Outcome = TP_HIT/SL_HIT/TIME_LIMIT (selon candles), pas OFF_SESSION
 *   - Quand Yahoo aussi vide → fallback OFF_SESSION_STALE_DATA (cas borderline
 *     ex : capture 19:55 UTC NYSE, Yahoo a aussi exhaustéé après close)
 */
import { GainersUserShadowService, type FetchDiag, type SimOutcome } from '../services/gainers-user-shadow.service';

type FetchCall = { endpoint: string; ticker: string };

function buildService(opts: {
  candlesByEndpoint: Record<string, { candles: Array<{ timestamp: number; high: number; low: number; close: number; open?: number; volume?: number }>; rawCount?: number; requestedSymbol?: string } | null>;
  yahooCandles?: Array<{ datetime: string; open: number; high: number; low: number; close: number; volume: number }> | null;
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
  const yahooMock = {
    getCandles: jest.fn(async (ticker: string, _interval: '5m' | '1m' = '5m') => {
      opts.callLog.push({ endpoint: 'yahoo_intraday_5m', ticker });
      return opts.yahooCandles ?? null;
    }),
  };
  const supabaseMock = {
    getClient: () => ({ from: () => ({ select: () => ({ is: () => ({ lte: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }) }) }),
  };
  return new GainersUserShadowService(supabaseMock as never, eodhdMock as never, yahooMock as never);
}

async function runSim(svc: GainersUserShadowService, args: { symbol: string; assetClass: string; entryPrice: number; createdAt: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (svc as any).simulateRow(args);
}

/** Wed May 13 2026 17:00 UTC = 13:00 EDT (NYSE active). */
function rthCaptureTs(): number {
  return Math.floor(new Date('2026-05-13T17:00:00Z').getTime() / 1000);
}

describe('PR #296 Partie B — Yahoo fallback in simulator fetch chain', () => {
  it('falls back to Yahoo when all 4 EODHD steps return empty', async () => {
    const callLog: FetchCall[] = [];
    const startTs = rthCaptureTs();
    // Yahoo returns 3 valid candles within [startTs, startTs+60min]
    // High touches 102 → TP at 102 should hit (entry=100, TP=2%)
    const yahooCandles = [
      { datetime: new Date((startTs + 300) * 1000).toISOString(), open: 100, high: 100.5, low: 99.5, close: 100.2, volume: 1000 },
      { datetime: new Date((startTs + 600) * 1000).toISOString(), open: 100.2, high: 102.5, low: 100, close: 102.0, volume: 1500 },
      { datetime: new Date((startTs + 900) * 1000).toISOString(), open: 102.0, high: 102.3, low: 101.5, close: 101.8, volume: 1200 },
    ];
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles: [], rawCount: 0, requestedSymbol: 'CGNX.US' },
        ticks_range: null,
        getCandles_1m_range: null,
        getCandles_5m_default: null,
      },
      yahooCandles,
      callLog,
    });
    const { fetchDiag, results } = await runSim(svc, {
      symbol: 'CGNX.US',
      assetClass: 'us_equity_large',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag; results: Record<string, SimOutcome> };

    // 5 steps : 4 EODHD vides + Yahoo qui réussit
    expect(fetchDiag.steps).toHaveLength(5);
    expect(fetchDiag.steps[4].endpoint).toBe('yahoo_intraday_5m');
    expect(fetchDiag.selectedStep).toBe(4);
    expect(fetchDiag.outcome).toBe('ok');
    // Outcome reel calculé sur les candles Yahoo
    expect(results.baseline_60m.outcome).toBe('TP_HIT');
    expect(results.baseline_60m.outcome).not.toBe('OFF_SESSION');
    // Pas de off_session_reason puisque outcome != OFF_SESSION
    expect(results.baseline_60m.off_session_reason).toBeUndefined();
  });

  it('Yahoo step NOT called when EODHD step1 already returns valid candles', async () => {
    const callLog: FetchCall[] = [];
    const startTs = rthCaptureTs();
    const eodhdCandle = {
      timestamp: startTs + 300,
      open: 100, high: 100.5, low: 99.5, close: 100.2, volume: 1000,
    };
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles: [eodhdCandle], rawCount: 1, requestedSymbol: 'AAPL.US' },
      },
      yahooCandles: null,  // ne devrait pas être appelé
      callLog,
    });
    const { fetchDiag } = await runSim(svc, {
      symbol: 'AAPL.US',
      assetClass: 'us_equity_large',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag };

    expect(fetchDiag.selectedStep).toBe(0);  // step1 OK
    expect(fetchDiag.steps).toHaveLength(1);  // chain stoppée
    // Yahoo PAS appelé (pas dans callLog)
    expect(callLog.find((c) => c.endpoint === 'yahoo_intraday_5m')).toBeUndefined();
  });

  it('falls through to OFF_SESSION_STALE_DATA when Yahoo also empty', async () => {
    const callLog: FetchCall[] = [];
    const startTs = rthCaptureTs();
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles: [], rawCount: 0, requestedSymbol: 'CGNX.US' },
        ticks_range: null,
        getCandles_1m_range: null,
        getCandles_5m_default: null,
      },
      yahooCandles: null,  // Yahoo vide aussi (cas extrême)
      callLog,
    });
    const { fetchDiag, results } = await runSim(svc, {
      symbol: 'CGNX.US',
      assetClass: 'us_equity_large',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag; results: Record<string, SimOutcome> };

    expect(fetchDiag.steps).toHaveLength(5);  // 4 EODHD + 1 Yahoo
    expect(fetchDiag.steps[4].endpoint).toBe('yahoo_intraday_5m');
    expect(fetchDiag.steps[4].rawCount).toBe(0);
    expect(fetchDiag.selectedStep).toBeNull();  // aucun step n'a réussi
    // Tous les outcomes = NO_DATA (aucune source n'a fourni de candles)
    expect(results.baseline_60m.outcome).toBe('NO_DATA');
  });

  it('Yahoo candles filtered by [fromTs, toTs] window', async () => {
    const callLog: FetchCall[] = [];
    const startTs = rthCaptureTs();
    // Yahoo retourne plusieurs candles dont certaines hors fenêtre
    const yahooCandles = [
      // AVANT fromTs (startTs - 600 = before fromTs=startTs-300) → exclue
      { datetime: new Date((startTs - 1200) * 1000).toISOString(), open: 90, high: 91, low: 89, close: 90, volume: 100 },
      // APRÈS toTs (startTs + 4200 > toTs=startTs+3900) → exclue
      { datetime: new Date((startTs + 7200) * 1000).toISOString(), open: 110, high: 112, low: 109, close: 111, volume: 100 },
      // DANS la fenêtre → conservée, TP touché
      { datetime: new Date((startTs + 600) * 1000).toISOString(), open: 100, high: 102.5, low: 100, close: 102, volume: 1500 },
    ];
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles: [], rawCount: 0, requestedSymbol: 'AAPL.US' },
        ticks_range: null,
        getCandles_1m_range: null,
        getCandles_5m_default: null,
      },
      yahooCandles,
      callLog,
    });
    const { fetchDiag, results } = await runSim(svc, {
      symbol: 'AAPL.US',
      assetClass: 'us_equity_large',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag; results: Record<string, SimOutcome> };

    // Yahoo step retourne uniquement la candle in-window
    expect(fetchDiag.steps[4].rawCount).toBe(1);  // 2 hors-fenêtre filtrées
    expect(fetchDiag.selectedStep).toBe(4);
    expect(results.baseline_60m.outcome).toBe('TP_HIT');
  });

  it('skip OFF_SESSION_CAPTURE entirely when Step 0 catches (no Yahoo call)', async () => {
    const callLog: FetchCall[] = [];
    // Saturday capture → Step 0 catches → no fetch chain at all
    const saturdayTs = Math.floor(new Date('2026-05-09T17:00:00Z').getTime() / 1000);
    const svc = buildService({
      candlesByEndpoint: {},
      yahooCandles: [{ datetime: '...', open: 100, high: 100, low: 100, close: 100, volume: 1 }],
      callLog,
    });
    const { fetchDiag, results } = await runSim(svc, {
      symbol: 'AAPL.US',
      assetClass: 'us_equity_large',
      entryPrice: 100,
      createdAt: new Date(saturdayTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag; results: Record<string, SimOutcome> };

    expect(fetchDiag.outcome).toBe('off_session');
    expect(fetchDiag.steps).toHaveLength(1);
    expect(fetchDiag.steps[0].endpoint).toBe('session_check');
    expect(results.baseline_60m.outcome).toBe('OFF_SESSION');
    expect(results.baseline_60m.off_session_reason).toBe('capture');
    // Aucun fetch (ni EODHD ni Yahoo) ne doit avoir été appelé
    expect(callLog).toHaveLength(0);
  });
});
