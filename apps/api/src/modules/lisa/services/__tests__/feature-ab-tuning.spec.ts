import {
  computeFeatureContributions,
  buildNarrative,
  type DailySnapshot,
} from '../feature-ab-tuning.helper';

const makeSnap = (date: string, pnl: number, flags: Record<string, boolean>): DailySnapshot => ({
  date, pnl_usd: pnl, flags, n_closes: 10,
});

describe('computeFeatureContributions', () => {
  it('snapshots vides → array vide', () => {
    expect(computeFeatureContributions([])).toEqual([]);
  });

  it('feature qui aide (ON jours rentables, OFF jours perdants)', () => {
    const snapshots = [
      makeSnap('2026-05-01', +30, { conviction_sizing: true }),
      makeSnap('2026-05-02', +25, { conviction_sizing: true }),
      makeSnap('2026-05-03', +35, { conviction_sizing: true }),
      makeSnap('2026-05-04', -10, { conviction_sizing: false }),
      makeSnap('2026-05-05', -15, { conviction_sizing: false }),
      makeSnap('2026-05-06', -5, { conviction_sizing: false }),
    ];
    const r = computeFeatureContributions(snapshots);
    expect(r).toHaveLength(1);
    const c = r[0];
    expect(c.flag_name).toBe('conviction_sizing');
    expect(c.n_days_on).toBe(3);
    expect(c.n_days_off).toBe(3);
    expect(c.mean_pnl_on).toBe(30);
    expect(c.mean_pnl_off).toBe(-10);
    expect(c.delta_pnl).toBe(40); // 30 - (-10)
    expect(c.recommendation).toBe('KEEP_ON');
  });

  it('feature qui détruit (ON jours perdants)', () => {
    const snapshots = [
      makeSnap('2026-05-01', -25, { reverse_momentum: true }),
      makeSnap('2026-05-02', -30, { reverse_momentum: true }),
      makeSnap('2026-05-03', -20, { reverse_momentum: true }),
      makeSnap('2026-05-04', +10, { reverse_momentum: false }),
      makeSnap('2026-05-05', +5, { reverse_momentum: false }),
      makeSnap('2026-05-06', +15, { reverse_momentum: false }),
    ];
    const r = computeFeatureContributions(snapshots);
    expect(r[0].delta_pnl).toBeLessThan(0);
    expect(r[0].recommendation).toBe('TOGGLE_OFF');
  });

  it('sample insuffisant (<3 jours ON) → INCONCLUSIVE', () => {
    const snapshots = [
      makeSnap('2026-05-01', +30, { x: true }),
      makeSnap('2026-05-02', -10, { x: false }),
      makeSnap('2026-05-03', -10, { x: false }),
      makeSnap('2026-05-04', -10, { x: false }),
    ];
    expect(computeFeatureContributions(snapshots)[0].recommendation).toBe('INCONCLUSIVE');
  });

  it('delta sous le seuil minDelta → INCONCLUSIVE', () => {
    const snapshots = [
      makeSnap('2026-05-01', +2, { x: true }),
      makeSnap('2026-05-02', +3, { x: true }),
      makeSnap('2026-05-03', +1, { x: true }),
      makeSnap('2026-05-04', -1, { x: false }),
      makeSnap('2026-05-05', -2, { x: false }),
      makeSnap('2026-05-06', 0, { x: false }),
    ];
    // delta = 2 - (-1) = 3, sous minDelta=5 → INCONCLUSIVE
    expect(computeFeatureContributions(snapshots)[0].recommendation).toBe('INCONCLUSIVE');
  });

  it('plusieurs flags ranked par |delta| DESC', () => {
    const snapshots = [
      makeSnap('2026-05-01', +30, { a: true, b: false }),
      makeSnap('2026-05-02', +30, { a: true, b: false }),
      makeSnap('2026-05-03', +30, { a: true, b: false }),
      makeSnap('2026-05-04', -20, { a: false, b: true }),
      makeSnap('2026-05-05', -20, { a: false, b: true }),
      makeSnap('2026-05-06', -20, { a: false, b: true }),
    ];
    const r = computeFeatureContributions(snapshots);
    expect(r).toHaveLength(2);
    // delta_a = 30-(-20) = 50, delta_b = -20-30 = -50 → both magnitude 50
    // ordered by |delta| DESC
    expect(Math.abs(r[0].delta_pnl)).toBeGreaterThanOrEqual(Math.abs(r[1].delta_pnl));
  });
});

describe('buildNarrative', () => {
  it('aucune donnée → message générique', () => {
    expect(buildNarrative([])).toContain('Aucune donnée');
  });

  it('uniquement INCONCLUSIVE → message sample insuffisant', () => {
    const r = buildNarrative([{
      flag_name: 'x', n_days_on: 1, n_days_off: 1, mean_pnl_on: 5, mean_pnl_off: 0,
      delta_pnl: 5, total_pnl_on: 5, total_pnl_off: 0, recommendation: 'INCONCLUSIVE',
    }]);
    expect(r).toContain('insuffisant');
  });

  it('KEEP_ON + TOGGLE_OFF → 2 sections', () => {
    const r = buildNarrative([
      { flag_name: 'good', n_days_on: 5, n_days_off: 5, mean_pnl_on: 30, mean_pnl_off: -10, delta_pnl: 40, total_pnl_on: 150, total_pnl_off: -50, recommendation: 'KEEP_ON' },
      { flag_name: 'bad', n_days_on: 5, n_days_off: 5, mean_pnl_on: -20, mean_pnl_off: 10, delta_pnl: -30, total_pnl_on: -100, total_pnl_off: 50, recommendation: 'TOGGLE_OFF' },
    ]);
    expect(r).toContain('APPORTENT');
    expect(r).toContain('good');
    expect(r).toContain('RECONSIDÉRER');
    expect(r).toContain('bad');
  });
});
