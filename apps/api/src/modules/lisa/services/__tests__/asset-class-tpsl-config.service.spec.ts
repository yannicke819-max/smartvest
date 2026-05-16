import { AssetClassTpSlConfigService } from '../asset-class-tpsl-config.service';
import type { SupabaseService } from '../../../supabase/supabase.service';

interface SupabaseStubOptions {
  rows?: Array<{ asset_class: string; tp_pct: number; sl_pct: number }>;
  error?: { message: string } | null;
  ready?: boolean;
  /** Compteur de calls .from() pour assertion stale-reload. */
  calls?: { count: number };
}

function makeSupabaseStub(opts: SupabaseStubOptions): SupabaseService {
  const ready = opts.ready ?? true;
  const counter = opts.calls ?? { count: 0 };
  return {
    isReady: () => ready,
    getClient: () => ({
      from: (_table: string) => ({
        select: (_cols: string) => {
          counter.count += 1;
          return Promise.resolve({ data: opts.rows ?? null, error: opts.error ?? null });
        },
      }),
    }),
  } as unknown as SupabaseService;
}

const SEED = [
  { asset_class: 'asia_equity', tp_pct: 0.03, sl_pct: -0.013 },
  { asset_class: 'eu_equity', tp_pct: 0.025, sl_pct: -0.018 },
  { asset_class: 'us_equity_large', tp_pct: 0.025, sl_pct: -0.013 },
  { asset_class: 'us_equity_small_mid', tp_pct: 0.028, sl_pct: -0.015 },
  { asset_class: 'crypto_major', tp_pct: 0.022, sl_pct: -0.012 },
];

describe('AssetClassTpSlConfigService', () => {
  it('onModuleInit charge les 5 lignes seed', async () => {
    const svc = new AssetClassTpSlConfigService(makeSupabaseStub({ rows: SEED }));
    await svc.onModuleInit();
    expect(svc.getCacheSnapshot()).toHaveLength(5);
  });

  it('getTpPct(asia_equity) → 0.030 (décimal en DB)', async () => {
    const svc = new AssetClassTpSlConfigService(makeSupabaseStub({ rows: SEED }));
    await svc.onModuleInit();
    expect(svc.getTpPct('asia_equity')).toBe(0.03);
  });

  it('getSlPct(eu_equity) → -0.018', async () => {
    const svc = new AssetClassTpSlConfigService(makeSupabaseStub({ rows: SEED }));
    await svc.onModuleInit();
    expect(svc.getSlPct('eu_equity')).toBe(-0.018);
  });

  it('getTpPct(unknown_class) → null (caller fallback env)', async () => {
    const svc = new AssetClassTpSlConfigService(makeSupabaseStub({ rows: SEED }));
    await svc.onModuleInit();
    expect(svc.getTpPct('fx_major')).toBeNull();
    expect(svc.getSlPct('commodity')).toBeNull();
  });

  it('reload échec Supabase → cache précédent conservé (fail-open)', async () => {
    const svc = new AssetClassTpSlConfigService(makeSupabaseStub({ rows: SEED }));
    await svc.onModuleInit();
    expect(svc.getTpPct('asia_equity')).toBe(0.03);

    // Inject a failing stub for the next reload
    const failingStub = makeSupabaseStub({ error: { message: 'connection reset' } });
    // Patch reference via Object.assign to keep the same instance
    Object.assign(svc as unknown as { supabase: SupabaseService }, { supabase: failingStub });
    await svc.reload();

    // Cache précédent toujours là
    expect(svc.getTpPct('asia_equity')).toBe(0.03);
    expect(svc.getCacheSnapshot()).toHaveLength(5);
  });

  it('reload returns empty → cache précédent conservé', async () => {
    const svc = new AssetClassTpSlConfigService(makeSupabaseStub({ rows: SEED }));
    await svc.onModuleInit();
    expect(svc.getCacheSnapshot()).toHaveLength(5);

    Object.assign(svc as unknown as { supabase: SupabaseService }, {
      supabase: makeSupabaseStub({ rows: [] }),
    });
    await svc.reload();

    // Cache précédent toujours là (pas de wipe sur empty result)
    expect(svc.getCacheSnapshot()).toHaveLength(5);
  });

  it('Supabase not ready → reload no-op silencieux', async () => {
    const svc = new AssetClassTpSlConfigService(makeSupabaseStub({ ready: false }));
    await svc.onModuleInit();
    expect(svc.getCacheSnapshot()).toHaveLength(0);
    expect(svc.getTpPct('asia_equity')).toBeNull();
  });

  it('stale detection : retour cache courant immédiat + reload async déclenché', async () => {
    jest.useFakeTimers();
    const calls = { count: 0 };
    const stub = makeSupabaseStub({ rows: SEED, calls });
    const svc = new AssetClassTpSlConfigService(stub);
    await svc.onModuleInit();
    expect(calls.count).toBe(1);

    // Avance > 60 s : cache stale
    jest.setSystemTime(Date.now() + 61_000);

    // Get retourne immédiatement valeur cachée
    expect(svc.getTpPct('asia_equity')).toBe(0.03);
    // Et déclenche reload async (compteur incrémenté)
    // Laisse une microtask pour que le reload démarre
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.count).toBe(2);

    jest.useRealTimers();
  });

  it('ignore les lignes avec valeurs non numériques (robustesse parse)', async () => {
    const svc = new AssetClassTpSlConfigService(
      makeSupabaseStub({
        rows: [
          { asset_class: 'asia_equity', tp_pct: 0.03, sl_pct: -0.013 },
          // @ts-expect-error volontairement corrompu
          { asset_class: 'bad', tp_pct: 'NaN', sl_pct: -0.01 },
        ],
      }),
    );
    await svc.onModuleInit();
    expect(svc.getCacheSnapshot()).toHaveLength(1);
    expect(svc.getTpPct('bad')).toBeNull();
  });
});
