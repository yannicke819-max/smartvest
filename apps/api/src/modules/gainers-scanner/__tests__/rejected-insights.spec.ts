/**
 * PR6.8 RCFT — RejectedInsightsService specs.
 *
 * Validation guardrails statistiques :
 *  - min_samples : retourne fp_rate=null si < min (anti div par 3 datapoints)
 *  - env_tag : isolation shadow vs canary (anti mélange)
 *  - sym ACCEPT/REJECT : compute fp_rate ET failure_rate
 *  - division par zéro : 0 data → stats vides, pas de NaN
 */

import { RejectedInsightsService } from '../automations/rejected-insights.service';

function makeMockSupabase(rows: any[]) {
  const builder: any = {
    select() { return builder; },
    eq() { return builder; },
    gte() { return builder; },
    limit() { return Promise.resolve({ data: rows, error: null }); },
  };
  return {
    getClient: () => ({ from: () => builder }),
  } as any;
}

describe('RejectedInsightsService', () => {
  it('returns empty stats when zero data (no division by zero)', async () => {
    const supabase = makeMockSupabase([]);
    const svc = new RejectedInsightsService(supabase);
    const result = await svc.getFalsePositiveRate();
    expect(result.global_fp_rate).toBeNull();
    expect(result.global_failure_rate).toBeNull();
    expect(result.accept_stats.fp_rate).toBeNull();
    expect(Object.keys(result.by_reason).length).toBe(0);
  });

  it('returns fp_rate=null when sample < min_samples (anti FP-rate sur 3 datapoints)', async () => {
    // 5 REJECT LIQUIDITY_FLOOR avec outcome computed, min_samples=20 default
    const rows = Array.from({ length: 5 }, (_, i) => ({
      symbol: `SYM${i}`,
      asset_class: 'crypto',
      decision: 'REJECT',
      reject_reason: 'LIQUIDITY_FLOOR',
      outcome: i < 2 ? 'champion' : 'neutral',
      return_72h: i < 2 ? 0.10 : 0.01,
      rejected_at: '2026-04-30T00:00:00Z',
    }));
    const supabase = makeMockSupabase(rows);
    const svc = new RejectedInsightsService(supabase);
    const result = await svc.getFalsePositiveRate({ minSamples: 20 });
    expect(result.by_reason.LIQUIDITY_FLOOR.total).toBe(5);
    expect(result.by_reason.LIQUIDITY_FLOOR.fp_rate).toBeNull(); // < min_samples
  });

  it('computes fp_rate correctly when sample >= min_samples', async () => {
    // 30 REJECT LIQUIDITY_FLOOR : 9 champions, 21 neutral → fp_rate = 30%
    const rows = Array.from({ length: 30 }, (_, i) => ({
      symbol: `SYM${i}`,
      asset_class: 'crypto',
      decision: 'REJECT',
      reject_reason: 'LIQUIDITY_FLOOR',
      outcome: i < 9 ? 'champion' : 'neutral',
      return_72h: i < 9 ? 0.08 : 0.01,
      rejected_at: '2026-04-30T00:00:00Z',
    }));
    const supabase = makeMockSupabase(rows);
    const svc = new RejectedInsightsService(supabase);
    const result = await svc.getFalsePositiveRate({ minSamples: 20 });
    expect(result.by_reason.LIQUIDITY_FLOOR.total).toBe(30);
    expect(result.by_reason.LIQUIDITY_FLOOR.champions).toBe(9);
    expect(result.by_reason.LIQUIDITY_FLOOR.fp_rate).toBeCloseTo(0.30);
  });

  it('computes ACCEPT failure_rate symmetrically', async () => {
    // 25 ACCEPT : 5 failures, 20 neutral → failure_rate = 20%
    const rows = Array.from({ length: 25 }, (_, i) => ({
      symbol: `SYM${i}`,
      asset_class: 'equity',
      decision: 'ACCEPT',
      reject_reason: null,
      outcome: i < 5 ? 'failure' : 'neutral',
      return_72h: i < 5 ? -0.05 : 0.01,
      rejected_at: '2026-04-30T00:00:00Z',
    }));
    const supabase = makeMockSupabase(rows);
    const svc = new RejectedInsightsService(supabase);
    const result = await svc.getFalsePositiveRate({ minSamples: 20 });
    expect(result.accept_stats.total).toBe(25);
    expect(result.accept_stats.failures).toBe(5);
    expect(result.accept_stats.failure_rate).toBeCloseTo(0.20);
  });

  it('separates by env_tag in fetch call (no mixing shadow/canary)', async () => {
    // Contrôle : eq('env_tag', 'canary') doit être appelé
    const eqSpy = jest.fn();
    const supabase = {
      getClient: () => ({
        from: () => ({
          select: () => ({
            eq: (col: string, val: string) => {
              eqSpy(col, val);
              return {
                gte: () => ({
                  limit: () => Promise.resolve({ data: [], error: null }),
                }),
              };
            },
          }),
        }),
      }),
    } as any;
    const svc = new RejectedInsightsService(supabase);
    await svc.getFalsePositiveRate({ envTag: 'canary' });
    expect(eqSpy).toHaveBeenCalledWith('env_tag', 'canary');
  });

  it('counts pending_outcome separately (T+72h not yet reached)', async () => {
    const rows = [
      { symbol: 'A', asset_class: 'crypto', decision: 'REJECT', reject_reason: 'LIQUIDITY_FLOOR',
        outcome: null, return_72h: null, rejected_at: '2026-05-02T00:00:00Z' },
      { symbol: 'B', asset_class: 'crypto', decision: 'REJECT', reject_reason: 'LIQUIDITY_FLOOR',
        outcome: 'champion', return_72h: 0.08, rejected_at: '2026-04-30T00:00:00Z' },
    ];
    const supabase = makeMockSupabase(rows);
    const svc = new RejectedInsightsService(supabase);
    const result = await svc.getFalsePositiveRate({ minSamples: 1 });
    expect(result.by_reason.LIQUIDITY_FLOOR.pending_outcome).toBe(1);
    // fp_rate computed only on evaluated (1 evaluated, 1 champion → fp_rate=1.0)
    expect(result.by_reason.LIQUIDITY_FLOOR.fp_rate).toBeCloseTo(1.0);
  });
});
