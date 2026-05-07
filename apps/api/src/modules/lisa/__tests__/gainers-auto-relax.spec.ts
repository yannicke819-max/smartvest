/**
 * PR #282 — Tests pure logic auto-relax (computeRelaxStep + shouldRelax).
 *
 * Le service complet est testé via integration (cron + Supabase mock) en
 * future itération. Ici on couvre la logique métier critique.
 */
import { computeRelaxStep, shouldRelax } from '../services/gainers-auto-relax.service';
import type { RegretGateRow } from '../services/gainers-user-shadow.service';

describe('computeRelaxStep', () => {
  it('subtracts 0.05 on path_eff with floor 0.20', () => {
    const rule = { gate: 'reject_path_eff', configColumn: 'gainers_min_path_efficiency', stepKind: 'subtract_0_05' as const, floor: 0.20 };
    expect(computeRelaxStep(rule, 0.45)).toEqual({ newValue: 0.40 });
    expect(computeRelaxStep(rule, 0.30)).toEqual({ newValue: 0.25 });
    expect(computeRelaxStep(rule, 0.25)).toEqual({ newValue: 0.20 });
    // At floor → no relax
    expect(computeRelaxStep(rule, 0.20)).toBeNull();
    // Below floor (user manually set lower) → no relax
    expect(computeRelaxStep(rule, 0.15)).toBeNull();
  });

  it('subtracts 0.05 on persistence with floor 0.40', () => {
    const rule = { gate: 'reject_persistence', configColumn: 'gainers_min_persistence_score', stepKind: 'subtract_0_05' as const, floor: 0.40 };
    expect(computeRelaxStep(rule, 0.66)).toEqual({ newValue: 0.61 });
    expect(computeRelaxStep(rule, 0.45)).toEqual({ newValue: 0.40 });
    expect(computeRelaxStep(rule, 0.40)).toBeNull();
    expect(computeRelaxStep(rule, 0.42)).toEqual({ newValue: 0.40 });  // clamps to floor
  });

  it('divides cooldown by 2 with floor 1', () => {
    const rule = { gate: 'reject_cooldown', configColumn: 'gainers_cooldown_minutes', stepKind: 'divide_2' as const, floor: 1 };
    expect(computeRelaxStep(rule, 60)).toEqual({ newValue: 30 });
    expect(computeRelaxStep(rule, 5)).toEqual({ newValue: 2 });
    expect(computeRelaxStep(rule, 2)).toEqual({ newValue: 1 });
    expect(computeRelaxStep(rule, 1)).toBeNull();   // at floor
    expect(computeRelaxStep(rule, 0)).toBeNull();   // would round down to 0, below floor
  });

  it('divides post_sl_cooldown by 2 with floor 15', () => {
    const rule = { gate: 'reject_post_sl_cooldown', configColumn: 'gainers_post_sl_cooldown_min', stepKind: 'divide_2' as const, floor: 15 };
    expect(computeRelaxStep(rule, 240)).toEqual({ newValue: 120 });
    expect(computeRelaxStep(rule, 60)).toEqual({ newValue: 30 });
    expect(computeRelaxStep(rule, 30)).toEqual({ newValue: 15 });
    expect(computeRelaxStep(rule, 15)).toBeNull();
    expect(computeRelaxStep(rule, 20)).toEqual({ newValue: 15 });  // 10 < floor, clamps
  });

  it('returns null for null/undefined/non-finite current value', () => {
    const rule = { gate: 'reject_path_eff', configColumn: 'gainers_min_path_efficiency', stepKind: 'subtract_0_05' as const, floor: 0.20 };
    expect(computeRelaxStep(rule, null)).toBeNull();
    expect(computeRelaxStep(rule, undefined)).toBeNull();
    expect(computeRelaxStep(rule, NaN)).toBeNull();
  });
});

describe('shouldRelax', () => {
  const baseRow = (overrides: Partial<RegretGateRow> = {}): RegretGateRow => ({
    decision: 'reject_path_eff',
    grid: 'baseline_60m',
    n: 50,
    mean_pnl_pct: 0.005,
    ci_low: 0.001,
    ci_high: 0.009,
    cumulative_regret_usd: 200,
    verdict: 'GATE_TOO_STRICT',
    ...overrides,
  });

  it('returns true on healthy candidate (verdict + n + regret all pass)', () => {
    expect(shouldRelax(baseRow())).toBe(true);
  });

  it('rejects non-baseline_60m grid', () => {
    expect(shouldRelax(baseRow({ grid: 'baseline_30m' }))).toBe(false);
    expect(shouldRelax(baseRow({ grid: 'alt15_60m' }))).toBe(false);
  });

  it('rejects verdict != GATE_TOO_STRICT', () => {
    expect(shouldRelax(baseRow({ verdict: 'GATE_HEALTHY' }))).toBe(false);
    expect(shouldRelax(baseRow({ verdict: 'INCONCLUSIVE' }))).toBe(false);
    expect(shouldRelax(baseRow({ verdict: 'INSUFFICIENT_DATA' }))).toBe(false);
  });

  it('rejects cumulative_regret_usd <= $150', () => {
    expect(shouldRelax(baseRow({ cumulative_regret_usd: 150 }))).toBe(false);
    expect(shouldRelax(baseRow({ cumulative_regret_usd: 100 }))).toBe(false);
    expect(shouldRelax(baseRow({ cumulative_regret_usd: 0 }))).toBe(false);
    expect(shouldRelax(baseRow({ cumulative_regret_usd: -50 }))).toBe(false);
  });

  it('rejects n_rejections < 30 (anti-luck threshold)', () => {
    expect(shouldRelax(baseRow({ n: 29 }))).toBe(false);
    expect(shouldRelax(baseRow({ n: 5 }))).toBe(false);
    expect(shouldRelax(baseRow({ n: 30 }))).toBe(true);
  });

  it('rejects gates not in RELAX_RULES (e.g. data quality)', () => {
    expect(shouldRelax(baseRow({ decision: 'reject_no_tf_data' }))).toBe(false);
    expect(shouldRelax(baseRow({ decision: 'reject_p_win' }))).toBe(false);
    expect(shouldRelax(baseRow({ decision: 'reject_budget_cap' }))).toBe(false);
    expect(shouldRelax(baseRow({ decision: 'reject_other' }))).toBe(false);
    expect(shouldRelax(baseRow({ decision: 'accept' }))).toBe(false);
  });

  it('accepts all 4 supported gate decisions', () => {
    for (const decision of ['reject_path_eff', 'reject_persistence', 'reject_cooldown', 'reject_post_sl_cooldown']) {
      expect(shouldRelax(baseRow({ decision }))).toBe(true);
    }
  });

  it('rejects when both volume and magnitude conditions fail (couplage)', () => {
    // High regret but low n → still rejected (luck not stat signal)
    expect(shouldRelax(baseRow({ n: 5, cumulative_regret_usd: 1000 }))).toBe(false);
    // High n but low regret → also rejected (volume mais pas de magnitude)
    expect(shouldRelax(baseRow({ n: 200, cumulative_regret_usd: 50 }))).toBe(false);
  });
});
