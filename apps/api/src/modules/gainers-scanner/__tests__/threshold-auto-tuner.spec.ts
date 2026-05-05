/**
 * PR #5 — Tests ThresholdAutoTunerService.
 *
 * Couvre :
 *   - computeSuggestions logique pure (sans I/O)
 *     · REJECT-side : fp_rate > 0.20 → assouplit
 *     · ACCEPT-side : failure_rate > 0.30 → resserre
 *     · n < 50 → skip (insufficient_data)
 *     · status='insufficient_data' → skip
 *     · clamp dans bracket ADR-005
 *     · effective delta < 1% (clamp absorbe) → skip
 *   - kill-switch env GAINERS_AUTO_TUNER_KILL_SWITCH
 */

import { ThresholdAutoTunerService } from '../automations/threshold-auto-tuner.service';

interface FpRateStats {
  total: number;
  champions: number;
  failures: number;
  neutral: number;
  pending_outcome: number;
  fp_rate: number | null;
  failure_rate: number | null;
  avg_return_72h: number | null;
  samples_top_missed: Array<{ symbol: string; return_72h: number; rejected_at: string }>;
  status: 'ok' | 'insufficient_data';
}

function makeStats(opts: Partial<FpRateStats>): FpRateStats {
  return {
    total: 100,
    champions: 0,
    failures: 0,
    neutral: 0,
    pending_outcome: 0,
    fp_rate: null,
    failure_rate: null,
    avg_return_72h: null,
    samples_top_missed: [],
    status: 'ok',
    ...opts,
  };
}

function makeService(envKillSwitch: string = 'false'): ThresholdAutoTunerService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = { getClient: () => ({}) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rejected: any = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insights: any = { logInsight: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = { get: (k: string) => (k === 'GAINERS_AUTO_TUNER_KILL_SWITCH' ? envKillSwitch : undefined) };
  return new ThresholdAutoTunerService(supabase, rejected, insights, config);
}

describe('ThresholdAutoTunerService.computeSuggestions', () => {
  it('REJECT-side : fp_rate > 0.20 sur PERSISTENCE → propose -5%', () => {
    const svc = makeService();
    const fpRate = {
      by_reason: {
        PERSISTENCE_BELOW_THRESHOLD: makeStats({ fp_rate: 0.25, total: 100, champions: 25 }),
      },
      accept_stats: makeStats({ status: 'insufficient_data' }),
      global_fp_rate: 0.25,
      global_failure_rate: null,
      env_tag: 'shadow',
      since_days: 14,
      min_samples: 50,
    };
    const portfolio = {
      portfolio_id: 'p1',
      gainers_auto_tuner_env: 'shadow' as const,
      gainers_min_persistence_score: 0.67,
      gainers_min_path_efficiency: 0.5,
    };
    const suggestions = svc.computeSuggestions(portfolio, fpRate);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].thresholdName).toBe('gainers_min_persistence_score');
    expect(suggestions[0].oldValue).toBe(0.67);
    expect(suggestions[0].newValue).toBeCloseTo(0.637, 3); // 0.67 × 0.95
    expect(suggestions[0].reason).toBe('fp_rate_too_high');
  });

  it('REJECT-side : fp_rate sur PATH_EFFICIENCY_LOW → propose path -5%', () => {
    const svc = makeService();
    const fpRate = {
      by_reason: {
        PATH_EFFICIENCY_LOW: makeStats({ fp_rate: 0.30, total: 80, champions: 24 }),
      },
      accept_stats: makeStats({ status: 'insufficient_data' }),
      global_fp_rate: 0.30,
      global_failure_rate: null,
      env_tag: 'shadow',
      since_days: 14,
      min_samples: 50,
    };
    const portfolio = {
      portfolio_id: 'p2',
      gainers_auto_tuner_env: 'shadow' as const,
      gainers_min_persistence_score: 0.67,
      gainers_min_path_efficiency: 0.5,
    };
    const suggestions = svc.computeSuggestions(portfolio, fpRate);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].thresholdName).toBe('gainers_min_path_efficiency');
    expect(suggestions[0].newValue).toBeCloseTo(0.475, 3); // 0.5 × 0.95
  });

  it('ACCEPT-side : failure_rate > 0.30 → resserre persistence +5%', () => {
    const svc = makeService();
    const fpRate = {
      by_reason: {},
      accept_stats: makeStats({
        status: 'ok',
        total: 100,
        failures: 35,
        failure_rate: 0.35,
      }),
      global_fp_rate: null,
      global_failure_rate: 0.35,
      env_tag: 'shadow',
      since_days: 14,
      min_samples: 50,
    };
    const portfolio = {
      portfolio_id: 'p3',
      gainers_auto_tuner_env: 'shadow' as const,
      gainers_min_persistence_score: 0.67,
      gainers_min_path_efficiency: 0.5,
    };
    const suggestions = svc.computeSuggestions(portfolio, fpRate);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].thresholdName).toBe('gainers_min_persistence_score');
    expect(suggestions[0].newValue).toBeCloseTo(0.704, 3); // 0.67 × 1.05
    expect(suggestions[0].reason).toBe('failure_rate_too_high');
  });

  it('skip si total < 50 (MIN_SAMPLES)', () => {
    const svc = makeService();
    const fpRate = {
      by_reason: {
        PERSISTENCE_BELOW_THRESHOLD: makeStats({ fp_rate: 0.30, total: 30, champions: 9 }),
      },
      accept_stats: makeStats({ status: 'insufficient_data' }),
      global_fp_rate: 0.30,
      global_failure_rate: null,
      env_tag: 'shadow',
      since_days: 14,
      min_samples: 50,
    };
    const portfolio = {
      portfolio_id: 'p4',
      gainers_auto_tuner_env: 'shadow' as const,
      gainers_min_persistence_score: 0.67,
      gainers_min_path_efficiency: 0.5,
    };
    const suggestions = svc.computeSuggestions(portfolio, fpRate);
    expect(suggestions).toHaveLength(0);
  });

  it('skip si status=insufficient_data même avec total ≥ 50', () => {
    const svc = makeService();
    const fpRate = {
      by_reason: {
        PERSISTENCE_BELOW_THRESHOLD: makeStats({ status: 'insufficient_data', total: 100 }),
      },
      accept_stats: makeStats({ status: 'insufficient_data' }),
      global_fp_rate: null,
      global_failure_rate: null,
      env_tag: 'shadow',
      since_days: 14,
      min_samples: 50,
    };
    const portfolio = {
      portfolio_id: 'p5',
      gainers_auto_tuner_env: 'shadow' as const,
      gainers_min_persistence_score: 0.67,
      gainers_min_path_efficiency: 0.5,
    };
    expect(svc.computeSuggestions(portfolio, fpRate)).toHaveLength(0);
  });

  it('skip si threshold absent du portfolio config', () => {
    const svc = makeService();
    const fpRate = {
      by_reason: {
        PERSISTENCE_BELOW_THRESHOLD: makeStats({ fp_rate: 0.30, total: 100, champions: 30 }),
      },
      accept_stats: makeStats({ status: 'insufficient_data' }),
      global_fp_rate: 0.30,
      global_failure_rate: null,
      env_tag: 'shadow',
      since_days: 14,
      min_samples: 50,
    };
    const portfolio = {
      portfolio_id: 'p6',
      gainers_auto_tuner_env: 'shadow' as const,
      gainers_min_persistence_score: null, // pas configuré
      gainers_min_path_efficiency: 0.5,
    };
    expect(svc.computeSuggestions(portfolio, fpRate)).toHaveLength(0);
  });

  it('clamp inférieur ADR-005 : persistence ne descend pas sous 0.5', () => {
    const svc = makeService();
    const fpRate = {
      by_reason: {
        PERSISTENCE_BELOW_THRESHOLD: makeStats({ fp_rate: 0.40, total: 100, champions: 40 }),
      },
      accept_stats: makeStats({ status: 'insufficient_data' }),
      global_fp_rate: 0.40,
      global_failure_rate: null,
      env_tag: 'shadow',
      since_days: 14,
      min_samples: 50,
    };
    const portfolio = {
      portfolio_id: 'p7',
      gainers_auto_tuner_env: 'shadow' as const,
      gainers_min_persistence_score: 0.51, // proche du floor 0.5
      gainers_min_path_efficiency: 0.5,
    };
    // 0.51 × 0.95 = 0.4845 → clamp à 0.5 → effectiveDelta = 0.01/0.51 = 1.96% > 1% → keep
    const suggestions = svc.computeSuggestions(portfolio, fpRate);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].newValue).toBe(0.5); // clamped
  });

  it('skip si delta effectif < 1% après clamp (mouvement insignifiant)', () => {
    const svc = makeService();
    const fpRate = {
      by_reason: {
        PERSISTENCE_BELOW_THRESHOLD: makeStats({ fp_rate: 0.30, total: 100, champions: 30 }),
      },
      accept_stats: makeStats({ status: 'insufficient_data' }),
      global_fp_rate: 0.30,
      global_failure_rate: null,
      env_tag: 'shadow',
      since_days: 14,
      min_samples: 50,
    };
    const portfolio = {
      portfolio_id: 'p8',
      gainers_auto_tuner_env: 'shadow' as const,
      gainers_min_persistence_score: 0.502, // very close to floor 0.5
      gainers_min_path_efficiency: 0.5,
    };
    // 0.502 × 0.95 = 0.477 → clamp 0.5 → effectiveDelta = 0.002/0.502 = 0.4% < 1%
    const suggestions = svc.computeSuggestions(portfolio, fpRate);
    expect(suggestions).toHaveLength(0);
  });

  it('REJECT-side OK : fp_rate ≤ 0.20 → pas de suggestion', () => {
    const svc = makeService();
    const fpRate = {
      by_reason: {
        PERSISTENCE_BELOW_THRESHOLD: makeStats({ fp_rate: 0.18, total: 100, champions: 18 }),
      },
      accept_stats: makeStats({ status: 'insufficient_data' }),
      global_fp_rate: 0.18,
      global_failure_rate: null,
      env_tag: 'shadow',
      since_days: 14,
      min_samples: 50,
    };
    const portfolio = {
      portfolio_id: 'p9',
      gainers_auto_tuner_env: 'shadow' as const,
      gainers_min_persistence_score: 0.67,
      gainers_min_path_efficiency: 0.5,
    };
    expect(svc.computeSuggestions(portfolio, fpRate)).toHaveLength(0);
  });

  it('combinaison : REJECT-side persistence + ACCEPT-side persistence → 2 suggestions', () => {
    const svc = makeService();
    const fpRate = {
      by_reason: {
        PERSISTENCE_BELOW_THRESHOLD: makeStats({ fp_rate: 0.25, total: 100, champions: 25 }),
      },
      accept_stats: makeStats({ status: 'ok', total: 100, failures: 35, failure_rate: 0.35 }),
      global_fp_rate: 0.25,
      global_failure_rate: 0.35,
      env_tag: 'shadow',
      since_days: 14,
      min_samples: 50,
    };
    const portfolio = {
      portfolio_id: 'p10',
      gainers_auto_tuner_env: 'shadow' as const,
      gainers_min_persistence_score: 0.67,
      gainers_min_path_efficiency: 0.5,
    };
    const suggestions = svc.computeSuggestions(portfolio, fpRate);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].reason).toBe('fp_rate_too_high');
    expect(suggestions[1].reason).toBe('failure_rate_too_high');
  });
});

describe('ThresholdAutoTunerService.isKillSwitchActive', () => {
  it('false par défaut', () => {
    expect(makeService('false').isKillSwitchActive()).toBe(false);
  });

  it('true si env GAINERS_AUTO_TUNER_KILL_SWITCH=true', () => {
    expect(makeService('true').isKillSwitchActive()).toBe(true);
  });

  it('case-insensitive : "TRUE" → true', () => {
    expect(makeService('TRUE').isKillSwitchActive()).toBe(true);
  });
});
