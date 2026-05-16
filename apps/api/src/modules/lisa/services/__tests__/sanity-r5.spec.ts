import { ConfigService } from '@nestjs/config';
import { SanityR5Service } from '../sanity-r5.service';
import type { SupabaseService } from '../../../supabase/supabase.service';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

function makeSupabaseSuccess(): SupabaseService & { inserts: unknown[] } {
  const inserts: unknown[] = [];
  return {
    isReady: () => true,
    getClient: () => ({
      from: (_t: string) => ({
        insert: (payload: unknown) => {
          inserts.push(payload);
          return Promise.resolve({ error: null });
        },
      }),
    }),
    inserts,
  } as unknown as SupabaseService & { inserts: unknown[] };
}

function makeSupabaseNoop(): SupabaseService {
  return {
    isReady: () => false,
    getClient: () => {
      throw new Error('not ready');
    },
  } as unknown as SupabaseService;
}

const BASE = {
  positionId: 'c01e6f74-4e1b-4556-b953-c3b079f691db',
  symbol: 'SEE.LSE',
  assetClass: 'eu_equity',
};

describe('SanityR5Service', () => {
  it('rejet exit_price=0 (smoking gun SEE.LSE)', async () => {
    const svc = new SanityR5Service(makeConfig({}), makeSupabaseSuccess());
    const r = await svc.validateExit({
      ...BASE,
      entryPrice: 200,
      exitPrice: 0,
      realizedPnlPct: -99.948,
    });
    expect(r.ok).toBe(false);
    expect(r.raison).toBe('exit_price_zero');
  });

  it('rejet exit_price négatif', async () => {
    const svc = new SanityR5Service(makeConfig({}), makeSupabaseSuccess());
    const r = await svc.validateExit({
      ...BASE,
      entryPrice: 200,
      exitPrice: -10,
      realizedPnlPct: -100,
    });
    expect(r.ok).toBe(false);
    expect(r.raison).toBe('exit_price_zero');
  });

  it('rejet exit < entry × 0.5 (ratio default)', async () => {
    const svc = new SanityR5Service(makeConfig({}), makeSupabaseSuccess());
    const r = await svc.validateExit({
      ...BASE,
      entryPrice: 200,
      exitPrice: 90, // < 100
      realizedPnlPct: -55,
    });
    expect(r.ok).toBe(false);
    // peut être rattrapé soit par exit_below_ratio soit par pnl_pct_below_threshold
    expect(['exit_below_ratio', 'pnl_pct_below_threshold']).toContain(r.raison);
  });

  it('rejet pnl_pct < -50 même si exit_price plausible', async () => {
    const svc = new SanityR5Service(makeConfig({}), makeSupabaseSuccess());
    const r = await svc.validateExit({
      ...BASE,
      entryPrice: 200,
      exitPrice: 199,
      realizedPnlPct: -60,
    });
    expect(r.ok).toBe(false);
    expect(r.raison).toBe('pnl_pct_below_threshold');
  });

  it('accept fermeture normale', async () => {
    const svc = new SanityR5Service(makeConfig({}), makeSupabaseSuccess());
    const r = await svc.validateExit({
      ...BASE,
      entryPrice: 200,
      exitPrice: 204,
      realizedPnlPct: 2.0,
    });
    expect(r.ok).toBe(true);
  });

  it('flag disabled → toujours ok', async () => {
    const svc = new SanityR5Service(
      makeConfig({ R5_SANITY_ENABLED: 'false' }),
      makeSupabaseSuccess(),
    );
    const r = await svc.validateExit({
      ...BASE,
      entryPrice: 200,
      exitPrice: 0,
      realizedPnlPct: -100,
    });
    expect(r.ok).toBe(true);
  });

  it('rejet écrit audit dans lisa_sanity_rejections', async () => {
    const supabase = makeSupabaseSuccess();
    const svc = new SanityR5Service(makeConfig({}), supabase);
    await svc.validateExit({
      ...BASE,
      entryPrice: 200,
      exitPrice: 0,
      realizedPnlPct: -100,
    });
    expect(supabase.inserts.length).toBe(1);
    expect(supabase.inserts[0]).toMatchObject({
      position_id: BASE.positionId,
      symbol: BASE.symbol,
      raison: 'exit_price_zero',
    });
  });

  it('Supabase down → ne throw pas, retourne ok=false', async () => {
    const svc = new SanityR5Service(makeConfig({}), makeSupabaseNoop());
    const r = await svc.validateExit({
      ...BASE,
      entryPrice: 200,
      exitPrice: 0,
      realizedPnlPct: -100,
    });
    expect(r.ok).toBe(false);
  });

  it('env override ratio à 0.8', async () => {
    const svc = new SanityR5Service(
      makeConfig({ R5_EXIT_PRICE_MIN_RATIO: '0.8' }),
      makeSupabaseSuccess(),
    );
    const r = await svc.validateExit({
      ...BASE,
      entryPrice: 200,
      exitPrice: 170, // ratio = 0.85, > 0.8 → ok pour le ratio mais pnl_pct -15 OK aussi
      realizedPnlPct: -15,
    });
    expect(r.ok).toBe(true);
  });
});
