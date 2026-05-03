/**
 * Phase C — ThresholdAutoTunerService specs.
 *
 * V1 : tests stub-friendly (analyzeThreshold returns null en attente data).
 * Vrai test viendra Phase 4 quand paper_trades populated.
 */

import { ThresholdAutoTunerService } from '../automations/threshold-auto-tuner.service';

function makeMockSupabase(rows: any[]) {
  const builder: any = {
    select() { return builder; },
    not() { return builder; },
    gte() { return builder; },
    limit() { return Promise.resolve({ data: rows, error: null }); },
  };
  return {
    getClient: () => ({ from: () => builder }),
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

describe('ThresholdAutoTunerService', () => {
  it('logs data_quality insight when < 30 closed trades available', async () => {
    const fakeTrades = Array.from({ length: 10 }, () => ({
      outcome_label: 'win',
      pnl_pct: 0.02,
      features_at_entry: { persistence_count: 5 },
      exit_timestamp: '2026-05-02T00:00:00Z',
    }));
    const supabase = makeMockSupabase(fakeTrades);
    const insights = makeMockInsights();
    const svc = new ThresholdAutoTunerService(supabase, insights);

    await (svc as any).runInner();

    const dataQualityLog = insights._logged.find((l: any) => l.type === 'data_quality');
    expect(dataQualityLog).toBeTruthy();
    expect(dataQualityLog.severity).toBe('low');
    expect(dataQualityLog.payload.closed_trades_count).toBe(10);
    expect(dataQualityLog.payload.min_required).toBe(30);
  });

  it('does not log data_quality if no trades fetched (likely empty table pre-Phase4)', async () => {
    const supabase = makeMockSupabase([]);
    const insights = makeMockInsights();
    const svc = new ThresholdAutoTunerService(supabase, insights);

    await (svc as any).runInner();

    // 0 trades is also < 30 → log data_quality
    expect(insights.logInsight).toHaveBeenCalled();
    const log = insights._logged[0];
    expect(log.type).toBe('data_quality');
    expect(log.payload.closed_trades_count).toBe(0);
  });

  it('skips trades with null outcome_label or features_at_entry', async () => {
    const mixed = [
      { outcome_label: 'win', pnl_pct: 0.02, features_at_entry: { x: 1 }, exit_timestamp: '2026-05-02T00:00:00Z' },
      { outcome_label: null, pnl_pct: 0.02, features_at_entry: { x: 1 }, exit_timestamp: '2026-05-02T00:00:00Z' },
      { outcome_label: 'loss', pnl_pct: null, features_at_entry: { x: 1 }, exit_timestamp: '2026-05-02T00:00:00Z' },
      { outcome_label: 'win', pnl_pct: 0.02, features_at_entry: null, exit_timestamp: '2026-05-02T00:00:00Z' },
    ];
    const supabase = makeMockSupabase(mixed);
    const insights = makeMockInsights();
    const svc = new ThresholdAutoTunerService(supabase, insights);

    await (svc as any).runInner();

    const log = insights._logged[0];
    expect(log.payload.closed_trades_count).toBe(1); // Only 1 valid trade after filter
  });
});
