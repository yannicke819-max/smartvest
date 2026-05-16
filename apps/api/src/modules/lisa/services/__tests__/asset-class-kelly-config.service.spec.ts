import { AssetClassKellyConfigService } from '../asset-class-kelly-config.service';
import type { SupabaseService } from '../../../supabase/supabase.service';

interface RowShape {
  asset_class: string;
  notional_usd: number;
  kelly_fraction: number;
  sample_size: number;
}

function makeSupabaseStub(rows: RowShape[] | null, ready = true, error: { message: string } | null = null): SupabaseService {
  return {
    isReady: () => ready,
    getClient: () => ({
      from: (_t: string) => ({
        select: (_cols: string) => Promise.resolve({ data: rows, error }),
      }),
    }),
  } as unknown as SupabaseService;
}

const SEED: RowShape[] = [
  { asset_class: 'us_equity_large', notional_usd: 1800, kelly_fraction: 0.12, sample_size: 46 },
  { asset_class: 'eu_equity', notional_usd: 1575, kelly_fraction: 0, sample_size: 38 },
  { asset_class: 'asia_equity', notional_usd: 2200, kelly_fraction: 0.18, sample_size: 80 },
  { asset_class: 'us_equity_small_mid', notional_usd: 1500, kelly_fraction: 0.10, sample_size: 27 },
];

describe('AssetClassKellyConfigService', () => {
  it('charge le cache au onModuleInit (4 lignes seed)', async () => {
    const svc = new AssetClassKellyConfigService(makeSupabaseStub(SEED));
    await svc.onModuleInit();
    expect(svc.getCacheSnapshot()).toHaveLength(4);
  });

  it('getNotionalUsd retourne le notional pour classe activée (kelly>0, sample>=30)', async () => {
    const svc = new AssetClassKellyConfigService(makeSupabaseStub(SEED));
    await svc.onModuleInit();
    expect(svc.getNotionalUsd('us_equity_large')).toBe(1800);
    expect(svc.getNotionalUsd('asia_equity')).toBe(2200);
  });

  it('getNotionalUsd retourne null si kelly_fraction = 0 (edge négatif)', async () => {
    const svc = new AssetClassKellyConfigService(makeSupabaseStub(SEED));
    await svc.onModuleInit();
    expect(svc.getNotionalUsd('eu_equity')).toBeNull();
  });

  it('getNotionalUsd retourne null si sample_size < 30', async () => {
    const svc = new AssetClassKellyConfigService(makeSupabaseStub(SEED));
    await svc.onModuleInit();
    expect(svc.getNotionalUsd('us_equity_small_mid')).toBeNull();
  });

  it('getNotionalUsd retourne null pour classe absente du cache', async () => {
    const svc = new AssetClassKellyConfigService(makeSupabaseStub(SEED));
    await svc.onModuleInit();
    expect(svc.getNotionalUsd('crypto_major')).toBeNull();
    expect(svc.getNotionalUsd('fx_major')).toBeNull();
  });

  it('Supabase not ready → reload no-op, cache vide', async () => {
    const svc = new AssetClassKellyConfigService(makeSupabaseStub(null, false));
    await svc.onModuleInit();
    expect(svc.getCacheSnapshot()).toHaveLength(0);
    expect(svc.getNotionalUsd('us_equity_large')).toBeNull();
  });

  it('reload échec Supabase → cache précédent conservé (fail-open)', async () => {
    const svc = new AssetClassKellyConfigService(makeSupabaseStub(SEED));
    await svc.onModuleInit();
    expect(svc.getNotionalUsd('us_equity_large')).toBe(1800);

    Object.assign(svc as unknown as { supabase: SupabaseService }, {
      supabase: makeSupabaseStub(null, true, { message: 'connection reset' }),
    });
    await svc.reload();

    expect(svc.getNotionalUsd('us_equity_large')).toBe(1800); // toujours là
  });

  it('reload empty → cache précédent conservé', async () => {
    const svc = new AssetClassKellyConfigService(makeSupabaseStub(SEED));
    await svc.onModuleInit();
    expect(svc.getCacheSnapshot()).toHaveLength(4);

    Object.assign(svc as unknown as { supabase: SupabaseService }, {
      supabase: makeSupabaseStub([], true),
    });
    await svc.reload();

    expect(svc.getCacheSnapshot()).toHaveLength(4);
  });

  it('ignore les lignes avec valeurs non numériques (robustesse parse)', async () => {
    const corrupted = {
      asset_class: 'bad',
      notional_usd: 'NaN' as unknown as number,
      kelly_fraction: 0.10,
      sample_size: 50,
    };
    const svc = new AssetClassKellyConfigService(
      makeSupabaseStub([
        { asset_class: 'us_equity_large', notional_usd: 1800, kelly_fraction: 0.12, sample_size: 46 },
        corrupted,
      ]),
    );
    await svc.onModuleInit();
    expect(svc.getCacheSnapshot()).toHaveLength(1);
    expect(svc.getNotionalUsd('bad')).toBeNull();
  });

  it('stale detection : trigger reload async, retour immédiat valeur cachée', async () => {
    jest.useFakeTimers();
    let callCount = 0;
    const supabase = {
      isReady: () => true,
      getClient: () => ({
        from: (_t: string) => ({
          select: (_c: string) => {
            callCount += 1;
            return Promise.resolve({ data: SEED, error: null });
          },
        }),
      }),
    } as unknown as SupabaseService;

    const svc = new AssetClassKellyConfigService(supabase);
    await svc.onModuleInit();
    expect(callCount).toBe(1);

    jest.setSystemTime(Date.now() + 61_000); // > TTL 60s
    expect(svc.getNotionalUsd('us_equity_large')).toBe(1800);
    await Promise.resolve();
    await Promise.resolve();
    expect(callCount).toBe(2);

    jest.useRealTimers();
  });
});
