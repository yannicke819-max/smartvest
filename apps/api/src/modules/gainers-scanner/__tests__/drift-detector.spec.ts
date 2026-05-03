/**
 * Phase B — DriftDetectorService specs.
 */

import { DriftDetectorService } from '../automations/drift-detector.service';

function makeMockSupabase(rowsByQuery: Array<Array<{
  decision: string;
  reject_reason: string | null;
  diverges_from_legacy: boolean | null;
  created_at: string;
}>>) {
  let callIdx = 0;
  const builder: any = {
    select() { return builder; },
    gte() { return builder; },
    lt() { return builder; },
    limit() {
      const data = rowsByQuery[callIdx++] ?? [];
      return Promise.resolve({ data, error: null });
    },
  };
  return {
    getClient: () => ({
      from: () => builder,
    }),
  } as any;
}

function makeMockInsights() {
  const logged: any[] = [];
  return {
    logInsight: jest.fn(async (input: any) => {
      logged.push(input);
      return 'mock-id';
    }),
    _logged: logged,
  } as any;
}

describe('DriftDetectorService', () => {
  it('logs cadence_drift insight when ACCEPT count drops > 30% W-1 vs W-2', async () => {
    // W-1 (most recent): 5 ACCEPT, 50 total
    // W-2: 20 ACCEPT, 100 total → cadence ratio = 5/20 = 0.25 (75% drop) → trigger
    const w1 = Array.from({ length: 50 }, (_, i) => ({
      decision: i < 5 ? 'ACCEPT' : 'REJECT',
      reject_reason: i < 5 ? null : 'PERSISTENCE_BELOW_THRESHOLD',
      diverges_from_legacy: false,
      created_at: '2026-05-02T00:00:00Z',
    }));
    const w2 = Array.from({ length: 100 }, (_, i) => ({
      decision: i < 20 ? 'ACCEPT' : 'REJECT',
      reject_reason: i < 20 ? null : 'PERSISTENCE_BELOW_THRESHOLD',
      diverges_from_legacy: false,
      created_at: '2026-04-25T00:00:00Z',
    }));
    const supabase = makeMockSupabase([w1, w2]);
    const insights = makeMockInsights();
    const svc = new DriftDetectorService(supabase, insights);

    await (svc as any).runInner();

    expect(insights.logInsight).toHaveBeenCalled();
    const cadenceLog = insights._logged.find((l: any) => l.type === 'cadence_drift' && l.summary.includes('chute'));
    expect(cadenceLog).toBeTruthy();
    expect(cadenceLog.severity).toBe('high'); // 75% drop > 50%
    expect(cadenceLog.payload.cadence_ratio).toBeCloseTo(0.25);
  });

  it('logs reject_pattern when one reason concentrates > 60%', async () => {
    // W-1: 100 signals, 70× LIQUIDITY_FLOOR = 70% concentration
    const w1 = Array.from({ length: 100 }, (_, i) => ({
      decision: 'REJECT',
      reject_reason: i < 70 ? 'LIQUIDITY_FLOOR' : 'TREND_FILTER_FAIL',
      diverges_from_legacy: false,
      created_at: '2026-05-02T00:00:00Z',
    }));
    const supabase = makeMockSupabase([w1, []]);
    const insights = makeMockInsights();
    const svc = new DriftDetectorService(supabase, insights);

    await (svc as any).runInner();

    const concentrationLog = insights._logged.find((l: any) => l.type === 'reject_pattern');
    expect(concentrationLog).toBeTruthy();
    expect(concentrationLog.payload.reject_reason).toBe('LIQUIDITY_FLOOR');
    expect(concentrationLog.payload.concentration_pct).toBeCloseTo(0.70);
  });

  it('logs zero_accept_7d when no ACCEPT in 7 days with > 100 signals', async () => {
    const w1 = Array.from({ length: 200 }, () => ({
      decision: 'REJECT',
      reject_reason: 'PERSISTENCE_BELOW_THRESHOLD',
      diverges_from_legacy: false,
      created_at: '2026-05-02T00:00:00Z',
    }));
    const supabase = makeMockSupabase([w1, []]);
    const insights = makeMockInsights();
    const svc = new DriftDetectorService(supabase, insights);

    await (svc as any).runInner();

    const zeroLog = insights._logged.find((l: any) =>
      l.type === 'cadence_drift' && l.summary.includes('Aucun ACCEPT')
    );
    expect(zeroLog).toBeTruthy();
    expect(zeroLog.severity).toBe('high');
  });

  it('does not log if cadence stable and no concentration', async () => {
    // W-1: 10 ACCEPT, 50 total
    // W-2: 11 ACCEPT, 50 total → ratio 0.91 (9% drop) → no trigger
    const w1 = Array.from({ length: 50 }, (_, i) => ({
      decision: i < 10 ? 'ACCEPT' : 'REJECT',
      reject_reason: i < 10 ? null : i < 30 ? 'PERSISTENCE_BELOW_THRESHOLD' : 'TREND_FILTER_FAIL',
      diverges_from_legacy: false,
      created_at: '2026-05-02T00:00:00Z',
    }));
    const w2 = Array.from({ length: 50 }, (_, i) => ({
      decision: i < 11 ? 'ACCEPT' : 'REJECT',
      reject_reason: i < 11 ? null : i < 30 ? 'PERSISTENCE_BELOW_THRESHOLD' : 'TREND_FILTER_FAIL',
      diverges_from_legacy: false,
      created_at: '2026-04-25T00:00:00Z',
    }));
    const supabase = makeMockSupabase([w1, w2]);
    const insights = makeMockInsights();
    const svc = new DriftDetectorService(supabase, insights);

    await (svc as any).runInner();

    expect(insights.logInsight).not.toHaveBeenCalled();
  });
});
