import { KellyRecomputeService } from '../kelly-recompute.service';
import type { ConfigService } from '@nestjs/config';
import type { SupabaseService } from '../../../supabase/supabase.service';
import type { KellySizingService } from '../../../gainers-scanner/kelly/kelly-sizing.service';

interface FetchRow {
  status: string;
  realized_pnl_pct: number | null;
  exit_price: number | null;
  entry_price: number | null;
}

function makeConfig(map: Record<string, string> = {}): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

function makeKellySizingMock(result: {
  fractionSuggested: number | null;
  fullKelly: number;
  winRateLowerWilson: number;
}): KellySizingService & { compute: jest.Mock } {
  return {
    compute: jest.fn().mockReturnValue({
      ...result,
      inputs: {},
    }),
  } as unknown as KellySizingService & { compute: jest.Mock };
}

/**
 * Helper : crée un stub Supabase qui :
 *  - retourne `fetchRows` sur le SELECT lisa_positions (toute la chaîne .from.select.eq.eq.like.gte.gt.limit)
 *  - capture les payloads UPSERT sur asset_class_kelly_config
 */
function makeSupabaseStub(
  fetchRows: FetchRow[],
  options: { isReady?: boolean; selectError?: { message: string } | null; upsertError?: { message: string } | null } = {},
): { service: SupabaseService; upserts: Array<Record<string, unknown>> } {
  const upserts: Array<Record<string, unknown>> = [];
  const selectChain: any = {
    eq: () => selectChain,
    like: () => selectChain,
    gte: () => selectChain,
    gt: () => selectChain,
    limit: () => Promise.resolve({ data: fetchRows, error: options.selectError ?? null }),
  };
  const service = {
    isReady: () => options.isReady ?? true,
    getClient: () => ({
      from: (_t: string) => ({
        select: (_c: string) => selectChain,
        upsert: (payload: Record<string, unknown>) => {
          upserts.push(payload);
          return Promise.resolve({ error: options.upsertError ?? null });
        },
      }),
    }),
  } as unknown as SupabaseService;
  return { service, upserts };
}

function mkRow(status: string, pnlPct: number, entryPrice = 100, exitPrice = 102): FetchRow {
  return { status, realized_pnl_pct: pnlPct, entry_price: entryPrice, exit_price: exitPrice };
}

describe('KellyRecomputeService', () => {
  it('skip si n_closed < 30 (échantillon insuffisant)', async () => {
    const rows: FetchRow[] = Array.from({ length: 10 }, () => mkRow('closed_target', 2.5));
    const { service: supabase, upserts } = makeSupabaseStub(rows);
    const sizing = makeKellySizingMock({ fractionSuggested: 0.1, fullKelly: 0.2, winRateLowerWilson: 0.5 });
    const svc = new KellyRecomputeService(makeConfig(), supabase, sizing);

    await svc.recomputeForClass('us_equity_large');

    expect(sizing.compute).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });

  it('edge négatif → upsert notional=1575 fraction=0 source=auto_recompute_no_edge', async () => {
    const rows: FetchRow[] = [
      ...Array.from({ length: 10 }, () => mkRow('closed_target', 2.5)),
      ...Array.from({ length: 30 }, () => mkRow('closed_stop', -1.5)),
    ];
    const { service: supabase, upserts } = makeSupabaseStub(rows);
    const sizing = makeKellySizingMock({
      fractionSuggested: 0, // KellySizingService.compute renvoie 0 sur edge négatif
      fullKelly: -0.45,
      winRateLowerWilson: 0.12,
    });
    const svc = new KellyRecomputeService(makeConfig(), supabase, sizing);

    await svc.recomputeForClass('us_equity_large');

    expect(sizing.compute).toHaveBeenCalledTimes(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      asset_class: 'us_equity_large',
      notional_usd: 1575,
      kelly_fraction: 0,
      source: 'auto_recompute_no_edge',
      sample_size: 40,
    });
  });

  it('edge positif → notional = fraction × capital, clampé [500, 3000]', async () => {
    const rows: FetchRow[] = [
      ...Array.from({ length: 25 }, () => mkRow('closed_target', 3.0)),
      ...Array.from({ length: 15 }, () => mkRow('closed_stop', -1.0)),
    ];
    const { service: supabase, upserts } = makeSupabaseStub(rows);
    // fraction 0.12 × capital 15750 = $1890 → dans la fenêtre [500, 3000]
    const sizing = makeKellySizingMock({
      fractionSuggested: 0.12,
      fullKelly: 0.24,
      winRateLowerWilson: 0.55,
    });
    const svc = new KellyRecomputeService(makeConfig(), supabase, sizing);

    await svc.recomputeForClass('asia_equity');

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      asset_class: 'asia_equity',
      kelly_fraction: 0.12,
      source: 'auto_recompute',
    });
    expect(Number(upserts[0].notional_usd)).toBeCloseTo(1890, 0);
  });

  it('clamp upper $3000 si fraction × capital trop élevé', async () => {
    const rows: FetchRow[] = [
      ...Array.from({ length: 25 }, () => mkRow('closed_target', 3.0)),
      ...Array.from({ length: 15 }, () => mkRow('closed_stop', -1.0)),
    ];
    const { service: supabase, upserts } = makeSupabaseStub(rows);
    // fraction 0.25 × 15750 = 3937.5 → clamp 3000
    const sizing = makeKellySizingMock({
      fractionSuggested: 0.25,
      fullKelly: 0.5,
      winRateLowerWilson: 0.7,
    });
    const svc = new KellyRecomputeService(makeConfig(), supabase, sizing);

    await svc.recomputeForClass('asia_equity');

    expect(upserts[0].notional_usd).toBe(3000);
  });

  it('clamp lower $500 si fraction × capital trop faible', async () => {
    const rows: FetchRow[] = [
      ...Array.from({ length: 25 }, () => mkRow('closed_target', 3.0)),
      ...Array.from({ length: 15 }, () => mkRow('closed_stop', -1.0)),
    ];
    const { service: supabase, upserts } = makeSupabaseStub(rows);
    // fraction 0.01 × 15750 = $157 → clamp 500
    const sizing = makeKellySizingMock({
      fractionSuggested: 0.01,
      fullKelly: 0.02,
      winRateLowerWilson: 0.45,
    });
    const svc = new KellyRecomputeService(makeConfig(), supabase, sizing);

    await svc.recomputeForClass('asia_equity');

    expect(upserts[0].notional_usd).toBe(500);
  });

  it('Supabase not ready → skip recomputeAll sans crash', async () => {
    const { service: supabase, upserts } = makeSupabaseStub([], { isReady: false });
    const sizing = makeKellySizingMock({ fractionSuggested: 0.1, fullKelly: 0.2, winRateLowerWilson: 0.5 });
    const svc = new KellyRecomputeService(makeConfig(), supabase, sizing);

    await svc.recomputeAll();

    expect(sizing.compute).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });

  it('select error → log warn, pas d upsert, pas de throw', async () => {
    const { service: supabase, upserts } = makeSupabaseStub([], {
      selectError: { message: 'connection lost' },
    });
    const sizing = makeKellySizingMock({ fractionSuggested: 0.1, fullKelly: 0.2, winRateLowerWilson: 0.5 });
    const svc = new KellyRecomputeService(makeConfig(), supabase, sizing);

    await svc.recomputeForClass('us_equity_large');

    expect(sizing.compute).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });

  it('payoff ratio non calculable (slAvg null) → skip', async () => {
    // Que des closed_target, pas de closed_stop → slAvg null
    const rows: FetchRow[] = Array.from({ length: 40 }, () => mkRow('closed_target', 2.5));
    const { service: supabase, upserts } = makeSupabaseStub(rows);
    const sizing = makeKellySizingMock({ fractionSuggested: 0.1, fullKelly: 0.2, winRateLowerWilson: 0.5 });
    const svc = new KellyRecomputeService(makeConfig(), supabase, sizing);

    await svc.recomputeForClass('us_equity_large');

    expect(sizing.compute).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // PR #359 — no-edge reducer : WR < 20% + sample >= 30 → notional $800
  // ---------------------------------------------------------------------------
  it('PR #359 — edge négatif + WR<20% + n>=30 → notional=800 source=auto_recompute_reduced_low_wr', async () => {
    // 5 TP / 35 SL = WR 12.5% sur 40 trades (cas réel 19 mai us_large WR=19.3%)
    const rows: FetchRow[] = [
      ...Array.from({ length: 5 }, () => mkRow('closed_target', 2.0)),
      ...Array.from({ length: 35 }, () => mkRow('closed_stop', -1.3)),
    ];
    const { service: supabase, upserts } = makeSupabaseStub(rows);
    const sizing = makeKellySizingMock({
      fractionSuggested: 0,
      fullKelly: -0.5,
      winRateLowerWilson: 0.08,
    });
    const svc = new KellyRecomputeService(makeConfig(), supabase, sizing);

    await svc.recomputeForClass('us_equity_large');

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      asset_class: 'us_equity_large',
      notional_usd: 800,
      kelly_fraction: 0,
      source: 'auto_recompute_reduced_low_wr',
      sample_size: 40,
    });
  });

  it('PR #359 — edge négatif + WR>=20% → reste sur notional=1575 (pas de reducer)', async () => {
    // 10 TP / 30 SL = WR 25% → au-dessus du seuil 20%, fallback historique
    const rows: FetchRow[] = [
      ...Array.from({ length: 10 }, () => mkRow('closed_target', 2.0)),
      ...Array.from({ length: 30 }, () => mkRow('closed_stop', -1.5)),
    ];
    const { service: supabase, upserts } = makeSupabaseStub(rows);
    const sizing = makeKellySizingMock({
      fractionSuggested: 0,
      fullKelly: -0.2,
      winRateLowerWilson: 0.15,
    });
    const svc = new KellyRecomputeService(makeConfig(), supabase, sizing);

    await svc.recomputeForClass('asia_equity');

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      notional_usd: 1575,
      source: 'auto_recompute_no_edge',
    });
  });

  it('CAPITAL via env var KELLY_CAPITAL_ESTIME_USD prend le pas', async () => {
    const rows: FetchRow[] = [
      ...Array.from({ length: 25 }, () => mkRow('closed_target', 3.0)),
      ...Array.from({ length: 15 }, () => mkRow('closed_stop', -1.0)),
    ];
    const { service: supabase, upserts } = makeSupabaseStub(rows);
    const sizing = makeKellySizingMock({
      fractionSuggested: 0.1,
      fullKelly: 0.2,
      winRateLowerWilson: 0.55,
    });
    // 0.1 × 20000 = $2000
    const svc = new KellyRecomputeService(
      makeConfig({ KELLY_CAPITAL_ESTIME_USD: '20000' }),
      supabase,
      sizing,
    );

    await svc.recomputeForClass('asia_equity');

    expect(Number(upserts[0].notional_usd)).toBeCloseTo(2000, 0);
  });
});
