/**
 * PR #281 — Tests conversion shadow row → TradeOutcome.
 */
import {
  shadowRowToTrainingExample,
  SIM_FEATURE_NAMES,
} from '../services/gainers-shadow-features';

const REAL_FEATURES = ['persistenceCount', 'volRatio', 'rsi', 'closeToHigh', 'changePct'];
const ALL_FEATURES = [...REAL_FEATURES, ...SIM_FEATURE_NAMES];

describe('shadowRowToTrainingExample', () => {
  it('converts a TP_HIT shadow reject_path_eff row to outcomeLabel=1', () => {
    const ex = shadowRowToTrainingExample({
      decision: 'reject_path_eff',
      persistence_count: '6/6',
      persistence_score: 1.0,
      path_eff: 0.32,
      change_pct_1m: 6.6,
      sim_results: {
        baseline_60m: { outcome: 'TP_HIT', pnl_pct: 0.017 },  // 1.7% net (after slippage)
      },
    }, ALL_FEATURES);
    expect(ex).not.toBeNull();
    expect(ex!.outcomeLabel).toBe(1);
    expect(ex!.pnlPct).toBeCloseTo(1.7, 2);
    expect(ex!.persistenceCount).toBe('6/6');
    expect(ex!.features.is_simulated).toBe(1);
    expect(ex!.features.is_sim_x_reject_path_eff).toBe(1);
    expect(ex!.features.is_sim_x_reject_persistence).toBe(0);
    expect(ex!.features.is_sim_x_reject_cooldown).toBe(0);
    expect(ex!.features.persistenceCount).toBeCloseTo(1.0, 3);
    expect(ex!.features.changePct).toBe(6.6);
  });

  it('converts a SL_HIT shadow reject_persistence row to outcomeLabel=0', () => {
    const ex = shadowRowToTrainingExample({
      decision: 'reject_persistence',
      persistence_count: '3/6',
      persistence_score: 0.5,
      path_eff: 0.45,
      change_pct_1m: 2.1,
      sim_results: {
        baseline_60m: { outcome: 'SL_HIT', pnl_pct: -0.012 },
      },
    }, ALL_FEATURES);
    expect(ex).not.toBeNull();
    expect(ex!.outcomeLabel).toBe(0);
    expect(ex!.pnlPct).toBeCloseTo(-1.2, 2);
    expect(ex!.features.is_simulated).toBe(1);
    expect(ex!.features.is_sim_x_reject_persistence).toBe(1);
    expect(ex!.features.is_sim_x_reject_path_eff).toBe(0);
    expect(ex!.features.persistenceCount).toBeCloseTo(0.5, 3);
  });

  it('groups reject_post_sl_cooldown into the same interaction as reject_cooldown', () => {
    const ex = shadowRowToTrainingExample({
      decision: 'reject_post_sl_cooldown',
      persistence_count: '4/5',
      persistence_score: 0.8,
      path_eff: 0.55,
      change_pct_1m: 3.2,
      sim_results: {
        baseline_60m: { outcome: 'TIME_LIMIT', pnl_pct: 0.003 },
      },
    }, ALL_FEATURES);
    expect(ex).not.toBeNull();
    expect(ex!.features.is_sim_x_reject_cooldown).toBe(1);
    expect(ex!.outcomeLabel).toBe(1);  // pnl > 0 even on TIME_LIMIT
  });

  it('returns null for accept decision (avoid double-count with paper_trades)', () => {
    const ex = shadowRowToTrainingExample({
      decision: 'accept',
      persistence_count: '6/6',
      persistence_score: 1.0,
      path_eff: 0.78,
      change_pct_1m: 5.0,
      sim_results: {
        baseline_60m: { outcome: 'TP_HIT', pnl_pct: 0.017 },
      },
    }, ALL_FEATURES);
    expect(ex).toBeNull();
  });

  it('returns null when sim_results is null', () => {
    const ex = shadowRowToTrainingExample({
      decision: 'reject_path_eff',
      persistence_count: '6/6',
      persistence_score: 1.0,
      path_eff: 0.32,
      change_pct_1m: 6.6,
      sim_results: null,
    }, ALL_FEATURES);
    expect(ex).toBeNull();
  });

  it('returns null when baseline_60m outcome is NO_DATA', () => {
    const ex = shadowRowToTrainingExample({
      decision: 'reject_path_eff',
      persistence_count: '6/6',
      persistence_score: 1.0,
      path_eff: 0.32,
      change_pct_1m: 6.6,
      sim_results: {
        baseline_60m: { outcome: 'NO_DATA', pnl_pct: null },
      },
    }, ALL_FEATURES);
    expect(ex).toBeNull();
  });

  it('returns null when pnl_pct is missing or non-finite', () => {
    const exMissing = shadowRowToTrainingExample({
      decision: 'reject_path_eff',
      persistence_count: '6/6',
      persistence_score: 1.0,
      path_eff: 0.32,
      change_pct_1m: 6.6,
      sim_results: { baseline_60m: { outcome: 'TP_HIT' } },
    }, ALL_FEATURES);
    expect(exMissing).toBeNull();

    const exNaN = shadowRowToTrainingExample({
      decision: 'reject_path_eff',
      persistence_count: '6/6',
      persistence_score: 1.0,
      path_eff: 0.32,
      change_pct_1m: 6.6,
      sim_results: { baseline_60m: { outcome: 'TP_HIT', pnl_pct: NaN } },
    }, ALL_FEATURES);
    expect(exNaN).toBeNull();
  });

  it('initializes all feature names to 0 then sets the relevant ones', () => {
    const ex = shadowRowToTrainingExample({
      decision: 'reject_no_tf_data',
      persistence_count: null,
      persistence_score: null,
      path_eff: null,
      change_pct_1m: null,
      sim_results: { baseline_60m: { outcome: 'TIME_LIMIT', pnl_pct: 0 } },
    }, ALL_FEATURES);
    expect(ex).not.toBeNull();
    // All listed features must be present (= 0 by default)
    for (const f of ALL_FEATURES) {
      expect(ex!.features).toHaveProperty(f);
      expect(typeof ex!.features[f]).toBe('number');
      expect(Number.isFinite(ex!.features[f])).toBe(true);
    }
    expect(ex!.features.is_simulated).toBe(1);
    expect(ex!.features.is_sim_x_reject_no_tf_data).toBe(1);
    // pnl_pct exactly 0 → outcomeLabel = 0 (not > 0)
    expect(ex!.outcomeLabel).toBe(0);
  });

  it('reject_p_win sets is_simulated=1 but no specific interaction term', () => {
    const ex = shadowRowToTrainingExample({
      decision: 'reject_p_win',
      persistence_count: '5/6',
      persistence_score: 0.83,
      path_eff: 0.6,
      change_pct_1m: 4.0,
      sim_results: { baseline_60m: { outcome: 'SL_HIT', pnl_pct: -0.012 } },
    }, ALL_FEATURES);
    expect(ex).not.toBeNull();
    expect(ex!.features.is_simulated).toBe(1);
    expect(ex!.features.is_sim_x_reject_path_eff).toBe(0);
    expect(ex!.features.is_sim_x_reject_persistence).toBe(0);
    expect(ex!.features.is_sim_x_reject_cooldown).toBe(0);
    expect(ex!.features.is_sim_x_reject_no_tf_data).toBe(0);
  });
});
