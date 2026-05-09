/**
 * PR #289 — Tests revert TZ shift + OFF_SESSION detection.
 *
 * PR #288 avait introduit un +offset shift sur les candles Asia, basé sur
 * une mauvaise interprétation des timestamps EODHD. Postgres `to_timestamp`
 * confirme : EODHD retourne déjà real UTC. Le shift introduisait des
 * timestamps fictifs pour les rows captées DURANT session Asia.
 *
 * PR #289 :
 *   - Revert le shift (timestamps EODHD utilisés tels quels)
 *   - Garde le helper `getExchangeUtcOffsetSec` pour future session-aware logic
 *   - Détecte OFF_SESSION quand toutes les candles fetched < startTs
 *     (signe que la row a été captée hors session de trading active du
 *     symbole — typique scanner Asia pendant US session)
 *   - getRegretSummary exclut OFF_SESSION pour ne pas polluer les KPI
 */
import { GainersUserShadowService, type FetchDiag, type SimOutcome } from '../services/gainers-user-shadow.service';

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

/**
 * PR #296 — Helper to pick an UTC timestamp during the symbol's exchange
 * session, on a Wednesday (always a weekday). Avoids flakiness from
 * `Date.now()` which would land on weekends or off-hours.
 *
 * Wed May 13 2026:
 *   - .SHE / .SHG (Shanghai 09:30-15:00 +8) → 03:00 UTC = 11:00 Shanghai ✓
 *   - .US (NYSE 09:30-16:00 EDT) → 17:00 UTC = 13:00 EDT ✓
 *   - .NSE / .BSE (NSE 09:15-15:30 +5:30) → 06:00 UTC = 11:30 IST ✓
 */
function inSessionStartTs(symbol: string): number {
  const wed = '2026-05-13';
  if (symbol.endsWith('.US') || symbol.endsWith('.TO')) {
    return Math.floor(new Date(`${wed}T17:00:00Z`).getTime() / 1000);
  }
  if (symbol.endsWith('.NSE') || symbol.endsWith('.BSE')) {
    return Math.floor(new Date(`${wed}T06:00:00Z`).getTime() / 1000);
  }
  // Asia (.SHE/.SHG/.HK/.T/.KO/.KQ) ~ 03:00 UTC = covered by most APAC sessions
  return Math.floor(new Date(`${wed}T03:00:00Z`).getTime() / 1000);
}

describe('PR #289 — TZ shift reverted', () => {
  it('Asia ticker candles are NOT shifted (timestamps used as-is)', async () => {
    const callLog: FetchCall[] = [];
    // Row captured at startTs. Candle at startTs + 600 (+10min within sim window).
    // Avant PR #289 : ce candle aurait été shifté +8h → bien au-delà cutoff → NO_DATA.
    // Après PR #289 : timestamp utilisé tel quel → walkForward normal.
    // PR #296 : startTs = Wed in-session for .SHE (avoid Step 0 short-circuit).
    const startTs = inSessionStartTs('300161.SHE');
    const candles = [
      { timestamp: startTs + 300, open: 100, high: 100.5, low: 99.5, close: 100.2, volume: 1000 },
      { timestamp: startTs + 900, open: 100.2, high: 102.5, low: 100, close: 102.1, volume: 1500 },
    ];
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles, rawCount: 2, requestedSymbol: '300161.SHE' },
      },
      callLog,
    });
    const { fetchDiag, results } = await runSim(svc, {
      symbol: '300161.SHE',
      assetClass: 'asia_equity',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag; results: Record<string, SimOutcome> };

    expect(fetchDiag.applied_tz_offset_sec).toBe(0);     // pas de shift appliqué
    expect(fetchDiag.forwardCount).toBe(2);              // les 2 candles passent le filter
    expect(fetchDiag.outcome).toBe('ok');
    // T+15min, high=102.5 ≥ tp=102 → TP_HIT
    expect(results.baseline_60m.outcome).toBe('TP_HIT');
  });

  it('US ticker still has zero offset (no regression)', async () => {
    const callLog: FetchCall[] = [];
    // PR #296 : Wed in-session for .US.
    const startTs = inSessionStartTs('AAPL.US');
    const candles = [
      { timestamp: startTs + 300, open: 100, high: 100.5, low: 99.5, close: 100.2, volume: 1000 },
    ];
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles, rawCount: 1, requestedSymbol: 'AAPL.US' },
      },
      callLog,
    });
    const { fetchDiag } = await runSim(svc, {
      symbol: 'AAPL.US',
      assetClass: 'us_equity_large',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag };

    expect(fetchDiag.applied_tz_offset_sec).toBe(0);
    expect(fetchDiag.outcome).toBe('ok');
  });
});

describe('PR #289 — OFF_SESSION detection', () => {
  it('marks OFF_SESSION (stale_data) when all fetched candles are before startTs', async () => {
    const callLog: FetchCall[] = [];
    // PR #296 : startTs in-session for .SHE → Step 0 lets through.
    // Candles 11-12h before startTs simulate EODHD stale data → triggers
    // post-fetch OFF_SESSION marker with off_session_reason='stale_data'.
    const startTs = inSessionStartTs('300161.SHE');
    const candles = [
      { timestamp: startTs - 12 * 3600, open: 28, high: 28.5, low: 27.9, close: 28.2, volume: 1000 },
      { timestamp: startTs - 11 * 3600, open: 28.2, high: 28.5, low: 28.0, close: 28.42, volume: 1500 },
    ];
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles, rawCount: 2, requestedSymbol: '300161.SHE' },
      },
      callLog,
    });
    const { fetchDiag, results } = await runSim(svc, {
      symbol: '300161.SHE',
      assetClass: 'asia_equity',
      entryPrice: 28.42,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag; results: Record<string, SimOutcome> };

    expect(fetchDiag.outcome).toBe('off_session');
    expect(fetchDiag.forwardCount).toBe(0);
    // Tous les grids OFF_SESSION (pas de NO_DATA, pas de TIME_LIMIT)
    expect(results.baseline_60m.outcome).toBe('OFF_SESSION');
    expect(results.baseline_30m.outcome).toBe('OFF_SESSION');
    expect(results.alt15_60m.outcome).toBe('OFF_SESSION');
    expect(results.alt15_30m.outcome).toBe('OFF_SESSION');
    expect(results.baseline_60m.pnl_pct).toBeNull();
    expect(results.baseline_60m.exit_price).toBeNull();
  });

  it('does NOT mark OFF_SESSION when some candles >= startTs (normal flow)', async () => {
    const callLog: FetchCall[] = [];
    // PR #296 : Wed in-session for .SHE.
    const startTs = inSessionStartTs('300161.SHE');
    // Mix : 1 candle avant startTs + 2 après (forward filter en garde 2)
    const candles = [
      { timestamp: startTs - 600, open: 100, high: 100.5, low: 99.5, close: 99.8, volume: 1000 },
      { timestamp: startTs + 300, open: 100, high: 100.8, low: 99.5, close: 100.5, volume: 1500 },
      { timestamp: startTs + 900, open: 100.5, high: 101.5, low: 100, close: 101.2, volume: 2000 },
    ];
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles, rawCount: 3, requestedSymbol: '300161.SHE' },
      },
      callLog,
    });
    const { fetchDiag, results } = await runSim(svc, {
      symbol: '300161.SHE',
      assetClass: 'asia_equity',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag; results: Record<string, SimOutcome> };

    expect(fetchDiag.outcome).toBe('ok');
    expect(results.baseline_60m.outcome).toBe('TIME_LIMIT');  // 2 candles, no TP/SL hit
    expect(results.baseline_60m.outcome).not.toBe('OFF_SESSION');
  });

  it('NO_DATA (not OFF_SESSION) when zero candles fetched at all', async () => {
    const callLog: FetchCall[] = [];
    // PR #296 : Wed in-session for .NSE (so Step 0 doesn't short-circuit).
    const startTs = inSessionStartTs('HEG.NSE');
    const svc = buildService({
      candlesByEndpoint: {
        getCandles_5m_range: { candles: [], rawCount: 0, requestedSymbol: 'HEG.NSE' },
        ticks_range: null,
        getCandles_1m_range: null,
        getCandles_5m_default: null,
      },
      callLog,
    });
    const { fetchDiag, results } = await runSim(svc, {
      symbol: 'HEG.NSE',
      assetClass: 'asia_equity',
      entryPrice: 100,
      createdAt: new Date(startTs * 1000).toISOString(),
    }) as { fetchDiag: FetchDiag; results: Record<string, SimOutcome> };

    // Aucun endpoint n'a retourné de candle → NO_DATA, PAS OFF_SESSION
    // (sémantique : "EODHD n'a vraiment rien", distinct de "row hors session")
    expect(fetchDiag.outcome).toBe('no_data');
    expect(results.baseline_60m.outcome).toBe('NO_DATA');
    expect(results.baseline_60m.outcome).not.toBe('OFF_SESSION');
  });
});
