import {
  parseSizingABConfig,
  decideBucketAction,
  scalePnlToBucket,
  aggregateBucketStats,
  type ShadowSignalRow,
} from '../sizing-ab-test.helper';

describe('parseSizingABConfig', () => {
  it('env vide → enabled false, defaults respectés', () => {
    const cfg = parseSizingABConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.bucket_a.max_positions).toBe(3);
    expect(cfg.bucket_a.notional_usd).toBe(2800);
    expect(cfg.bucket_b.max_positions).toBe(12);
    expect(cfg.bucket_b.notional_usd).toBe(700);
    expect(cfg.bucket_baseline.max_positions).toBe(5);
    expect(cfg.bucket_baseline.notional_usd).toBe(787);
  });

  it('SIZING_AB_TEST_ENABLED=true propage', () => {
    const cfg = parseSizingABConfig({ SIZING_AB_TEST_ENABLED: 'true' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.bucket_a.enabled).toBe(true);
    expect(cfg.bucket_b.enabled).toBe(true);
  });

  it('override sizing custom', () => {
    const cfg = parseSizingABConfig({
      SIZING_AB_TEST_ENABLED: 'true',
      SIZING_AB_BUCKET_A_MAX_POS: '2',
      SIZING_AB_BUCKET_A_NOTIONAL: '4000',
      SIZING_AB_BUCKET_B_MAX_POS: '15',
      SIZING_AB_BUCKET_B_NOTIONAL: '500',
    });
    expect(cfg.bucket_a.max_positions).toBe(2);
    expect(cfg.bucket_a.notional_usd).toBe(4000);
    expect(cfg.bucket_b.max_positions).toBe(15);
    expect(cfg.bucket_b.notional_usd).toBe(500);
  });

  it('safety clamp : notional hors range → default', () => {
    const cfg = parseSizingABConfig({
      SIZING_AB_TEST_ENABLED: 'true',
      SIZING_AB_BUCKET_A_NOTIONAL: '50000', // > max 10000
      SIZING_AB_BUCKET_B_NOTIONAL: '10',    // < min 100
    });
    expect(cfg.bucket_a.notional_usd).toBe(2800); // fallback default
    expect(cfg.bucket_b.notional_usd).toBe(700);  // fallback default
  });

  it('safety clamp : max_positions hors range → default', () => {
    const cfg = parseSizingABConfig({
      SIZING_AB_TEST_ENABLED: 'true',
      SIZING_AB_BUCKET_A_MAX_POS: '50', // > 20
      SIZING_AB_BUCKET_B_MAX_POS: '0',  // < 1
    });
    expect(cfg.bucket_a.max_positions).toBe(3);
    expect(cfg.bucket_b.max_positions).toBe(12);
  });

  it('NaN inputs → defaults', () => {
    const cfg = parseSizingABConfig({
      SIZING_AB_TEST_ENABLED: 'true',
      SIZING_AB_BUCKET_A_NOTIONAL: 'abc',
      SIZING_AB_BUCKET_B_MAX_POS: 'xyz',
    });
    expect(cfg.bucket_a.notional_usd).toBe(2800);
    expect(cfg.bucket_b.max_positions).toBe(12);
  });
});

describe('decideBucketAction', () => {
  const bucketA = {
    name: 'A_concentrated' as const,
    max_positions: 3,
    notional_usd: 2800,
    enabled: true,
  };

  it('capacity dispo → shadow_opened', () => {
    expect(decideBucketAction(bucketA, 0).decision).toBe('shadow_opened');
    expect(decideBucketAction(bucketA, 2).decision).toBe('shadow_opened');
  });

  it('capacity full → shadow_capacity_full', () => {
    expect(decideBucketAction(bucketA, 3).decision).toBe('shadow_capacity_full');
    expect(decideBucketAction(bucketA, 5).decision).toBe('shadow_capacity_full');
  });

  it('bucket disabled → shadow_skipped', () => {
    const disabled = { ...bucketA, enabled: false };
    expect(decideBucketAction(disabled, 0).decision).toBe('shadow_skipped');
  });

  it('reason informatif', () => {
    expect(decideBucketAction(bucketA, 2).reason).toContain('3/3');
    expect(decideBucketAction(bucketA, 3).reason).toContain('3/3');
  });
});

describe('scalePnlToBucket', () => {
  it('scale linéaire au notional', () => {
    // +2% sur $2800 = +$56
    expect(scalePnlToBucket(2, 2800)).toBe(56);
    // -1.5% sur $700 = -$10.50
    expect(scalePnlToBucket(-1.5, 700)).toBe(-10.5);
    // +10% sur $2800 = +$280
    expect(scalePnlToBucket(10, 2800)).toBe(280);
  });

  it('round 2 décimales', () => {
    // 0.123% × $1000 = $1.23
    expect(scalePnlToBucket(0.1234, 1000)).toBe(1.23);
  });
});

describe('aggregateBucketStats', () => {
  it('regroupe par bucket et compute stats', () => {
    const rows: ShadowSignalRow[] = [
      // Bucket A : 3 opened, 2 closed, 1 winner +$80 sur $2800
      { bucket: 'A_concentrated', decision: 'shadow_opened', closed_at: '2026-05-22T...', realized_pnl_usd: 80, realized_pnl_pct: 2.857, notional_usd: 2800, max_positions: 3 },
      { bucket: 'A_concentrated', decision: 'shadow_opened', closed_at: '2026-05-22T...', realized_pnl_usd: -42, realized_pnl_pct: -1.5, notional_usd: 2800, max_positions: 3 },
      { bucket: 'A_concentrated', decision: 'shadow_opened', closed_at: null, realized_pnl_usd: null, realized_pnl_pct: null, notional_usd: 2800, max_positions: 3 },
      { bucket: 'A_concentrated', decision: 'shadow_capacity_full', closed_at: null, realized_pnl_usd: null, realized_pnl_pct: null, notional_usd: 2800, max_positions: 3 },
      // Bucket B : 2 opened, both closed, 1 winner +$10 sur $700
      { bucket: 'B_diversified', decision: 'shadow_opened', closed_at: '2026-05-22T...', realized_pnl_usd: 10, realized_pnl_pct: 1.428, notional_usd: 700, max_positions: 12 },
      { bucket: 'B_diversified', decision: 'shadow_opened', closed_at: '2026-05-22T...', realized_pnl_usd: -5, realized_pnl_pct: -0.714, notional_usd: 700, max_positions: 12 },
    ];
    const stats = aggregateBucketStats(rows);
    expect(stats).toHaveLength(2);

    const a = stats.find((s) => s.bucket === 'A_concentrated')!;
    expect(a.n_signals).toBe(4);
    expect(a.n_opened).toBe(3);
    expect(a.n_capacity_full).toBe(1);
    expect(a.n_closed).toBe(2);
    expect(a.sum_pnl_usd).toBe(38);
    expect(a.win_rate_pct).toBe(50);
    // Capital efficiency : sum_pnl / (3 × 2800) = 38 / 8400 = 0.452% rounded
    expect(a.capital_efficiency).toBeCloseTo(0.45, 1);

    const b = stats.find((s) => s.bucket === 'B_diversified')!;
    expect(b.n_signals).toBe(2);
    expect(b.n_opened).toBe(2);
    expect(b.n_closed).toBe(2);
    expect(b.sum_pnl_usd).toBe(5);
    expect(b.win_rate_pct).toBe(50);
    // 5 / (12 × 700) = 0.0595% rounded
    expect(b.capital_efficiency).toBeCloseTo(0.06, 1);
  });

  it('vide → array vide', () => {
    expect(aggregateBucketStats([])).toEqual([]);
  });

  it('ignore les rows pas-encore-closed dans pnl calc', () => {
    const rows: ShadowSignalRow[] = [
      { bucket: 'A_concentrated', decision: 'shadow_opened', closed_at: null, realized_pnl_usd: null, realized_pnl_pct: null, notional_usd: 2800, max_positions: 3 },
    ];
    const stats = aggregateBucketStats(rows);
    expect(stats[0].sum_pnl_usd).toBe(0);
    expect(stats[0].n_closed).toBe(0);
    expect(stats[0].win_rate_pct).toBe(0);
  });
});
