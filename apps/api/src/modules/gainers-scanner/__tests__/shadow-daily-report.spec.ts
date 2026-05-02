/**
 * Phase 3.2 PR6.2 — ShadowDailyReportService tests.
 */

import { ShadowDailyReportService } from '../shadow/shadow-daily-report.service';

interface MockTables {
  gainers_v1_shadow_signals?: any[];
  gainers_shadow_daily_report?: any[];
}

function makeMockSupabase(tables: MockTables = {}) {
  const upserts: any[] = [];
  return {
    upserts,
    getClient: () => ({
      from: (tableName: string) => {
        const data = (tables as any)[tableName] ?? [];
        const chain: any = {
          select: () => chain,
          gte: () => chain,
          lte: () => chain,
          lt: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
          upsert: async (payload: any) => {
            upserts.push({ table: tableName, payload });
            return { error: null };
          },
          then: (r: any) => r({ data, error: null }),
        };
        return chain;
      },
    }),
  } as any;
}

describe('ShadowDailyReportService', () => {
  describe('computeAndUpsert()', () => {
    it('returns null on fetch error and does not upsert', async () => {
      const supabase = {
        getClient: () => ({
          from: () => ({
            select: () => ({
              gte: () => ({
                lte: () => ({ then: (r: any) => r({ data: null, error: { message: 'boom' } }) }),
              }),
            }),
          }),
        }),
      } as any;
      const svc = new ShadowDailyReportService(supabase);
      const result = await svc.computeAndUpsert('2026-05-02');
      expect(result).toBeNull();
    });

    it('aggregates correctly with 0 signals (empty day)', async () => {
      const mock = makeMockSupabase({ gainers_v1_shadow_signals: [] });
      const svc = new ShadowDailyReportService(mock);
      const result = await svc.computeAndUpsert('2026-05-02');
      expect(result).not.toBeNull();
      expect(result!.totalSignals).toBe(0);
      expect(result!.acceptCount).toBe(0);
      expect(result!.winRate).toBeNull();
      expect(mock.upserts.length).toBe(1);
      expect(mock.upserts[0].table).toBe('gainers_shadow_daily_report');
    });

    it('aggregates ACCEPT + REJECT + closed PnL correctly', async () => {
      const signals = [
        { decision: 'ACCEPT', simulated_pnl_pct: 0.012, simulated_slippage_pct: 0.001, diverges_from_legacy: false, setup_type: 'PULLBACK_HL_FIBO' },
        { decision: 'ACCEPT', simulated_pnl_pct: -0.008, simulated_slippage_pct: -0.002, diverges_from_legacy: false, setup_type: 'VWAP_RECLAIM' },
        { decision: 'ACCEPT', simulated_pnl_pct: 0.020, simulated_slippage_pct: 0.001, diverges_from_legacy: true, setup_type: 'PULLBACK_HL_FIBO' },
        { decision: 'REJECT', simulated_pnl_pct: null, simulated_slippage_pct: null, diverges_from_legacy: false, setup_type: null },
        { decision: 'REJECT', simulated_pnl_pct: null, simulated_slippage_pct: null, diverges_from_legacy: false, setup_type: null },
      ];
      const mock = makeMockSupabase({ gainers_v1_shadow_signals: signals });
      const svc = new ShadowDailyReportService(mock);
      const result = await svc.computeAndUpsert('2026-05-02');
      expect(result!.totalSignals).toBe(5);
      expect(result!.acceptCount).toBe(3);
      expect(result!.rejectCount).toBe(2);
      expect(result!.closedCount).toBe(3);
      expect(result!.winCount).toBe(2); // pnl > 0
      expect(result!.lossCount).toBe(1);
      expect(result!.winRate).toBeCloseTo(2 / 3, 4);
      expect(result!.divergenceCount).toBe(1);
      expect(result!.divergencePct).toBeCloseTo(1 / 5, 4);
      expect(result!.triggerBreakdown.PULLBACK_HL_FIBO).toBe(2);
      expect(result!.triggerBreakdown.VWAP_RECLAIM).toBe(1);
    });

    it('flags high_slippage when avg > 0.6%', async () => {
      const signals = [
        { decision: 'ACCEPT', simulated_pnl_pct: 0.01, simulated_slippage_pct: 0.008, diverges_from_legacy: false, setup_type: 'PULLBACK_HL_FIBO' },
        { decision: 'ACCEPT', simulated_pnl_pct: 0.01, simulated_slippage_pct: 0.007, diverges_from_legacy: false, setup_type: 'PULLBACK_HL_FIBO' },
      ];
      const mock = makeMockSupabase({ gainers_v1_shadow_signals: signals });
      const svc = new ShadowDailyReportService(mock);
      const result = await svc.computeAndUpsert('2026-05-02');
      expect(result!.avgSlippagePct).toBeCloseTo(0.0075, 4);
      expect(result!.highSlippageFlag).toBe(true);
      // anomalous_fill_count counts |slip| > 1% (0.01)
      // 0.008 and 0.007 are both BELOW 0.01 → anomalousFill = 0
      expect(result!.anomalousFillCount).toBe(0);
    });

    it('counts anomalous_fill when |slippage| > 1%', async () => {
      const signals = [
        { decision: 'ACCEPT', simulated_pnl_pct: 0.01, simulated_slippage_pct: 0.012, diverges_from_legacy: false, setup_type: 'PULLBACK_HL_FIBO' },
        { decision: 'ACCEPT', simulated_pnl_pct: -0.01, simulated_slippage_pct: -0.015, diverges_from_legacy: false, setup_type: 'VWAP_RECLAIM' },
      ];
      const mock = makeMockSupabase({ gainers_v1_shadow_signals: signals });
      const svc = new ShadowDailyReportService(mock);
      const result = await svc.computeAndUpsert('2026-05-02');
      expect(result!.anomalousFillCount).toBe(2);
    });
  });
});
