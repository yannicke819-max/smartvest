import { QuickWinsStatsService } from '../quick-wins-stats.service';
import type { SupabaseService } from '../../../supabase/supabase.service';

interface Stub {
  statsRows?: Array<Record<string, unknown>> | null;
  recentRows?: Array<Record<string, unknown>> | null;
  recentLimitCaptured?: { last: number | null };
}

function makeSupabase(stub: Stub): SupabaseService {
  return {
    isReady: () => true,
    getClient: () => ({
      from: () => ({
        select: () => ({
          gte: () => ({
            limit: () => Promise.resolve({ data: stub.statsRows ?? null, error: null }),
          }),
          order: () => ({
            limit: (n: number) => {
              if (stub.recentLimitCaptured) stub.recentLimitCaptured.last = n;
              return Promise.resolve({ data: stub.recentRows ?? null, error: null });
            },
          }),
        }),
      }),
    }),
  } as unknown as SupabaseService;
}

describe('QuickWinsStatsService', () => {
  describe('stats24h()', () => {
    it('aggrège correctement les décisions par qw_id', async () => {
      const rows = [
        { qw_id: 'QW_1', decision: 'pass', would_have_passed_without_flag: false },
        { qw_id: 'QW_1', decision: 'block', would_have_passed_without_flag: true },
        { qw_id: 'QW_1', decision: 'block', would_have_passed_without_flag: true },
        { qw_id: 'QW_18', decision: 'modify', would_have_passed_without_flag: true },
      ];
      const svc = new QuickWinsStatsService(makeSupabase({ statsRows: rows }));
      const result = await svc.stats24h();
      expect(result).toHaveLength(2);

      const qw1 = result.find((r) => r.qw_id === 'QW_1')!;
      expect(qw1.total).toBe(3);
      expect(qw1.pass).toBe(1);
      expect(qw1.block).toBe(2);
      expect(qw1.modify).toBe(0);
      expect(qw1.shadow_would_have_passed).toBe(2);
    });

    it('calcule pct_block avec 1 décimale (block/total × 100)', async () => {
      const rows = [
        { qw_id: 'QW_46', decision: 'block', would_have_passed_without_flag: true },
        { qw_id: 'QW_46', decision: 'block', would_have_passed_without_flag: true },
        { qw_id: 'QW_46', decision: 'pass', would_have_passed_without_flag: false },
      ];
      const svc = new QuickWinsStatsService(makeSupabase({ statsRows: rows }));
      const result = await svc.stats24h();
      const qw46 = result.find((r) => r.qw_id === 'QW_46')!;
      expect(qw46.pct_block).toBe(66.7); // 2/3 = 0.6667 → 66.7
    });

    it('retourne tableau vide si table vide', async () => {
      const svc = new QuickWinsStatsService(makeSupabase({ statsRows: [] }));
      const result = await svc.stats24h();
      expect(result).toEqual([]);
    });

    it('résultat trié par qw_id ascendant', async () => {
      const rows = [
        { qw_id: 'QW_46', decision: 'pass', would_have_passed_without_flag: false },
        { qw_id: 'QW_1', decision: 'pass', would_have_passed_without_flag: false },
        { qw_id: 'QW_18', decision: 'modify', would_have_passed_without_flag: true },
      ];
      const svc = new QuickWinsStatsService(makeSupabase({ statsRows: rows }));
      const result = await svc.stats24h();
      expect(result.map((r) => r.qw_id)).toEqual(['QW_1', 'QW_18', 'QW_46']);
    });
  });

  describe('recent()', () => {
    it('clamp limit à [1, 200]', async () => {
      const captured = { last: null as number | null };
      const svc = new QuickWinsStatsService(
        makeSupabase({ recentRows: [], recentLimitCaptured: captured }),
      );

      await svc.recent(500);
      expect(captured.last).toBe(200);

      await svc.recent(-5);
      expect(captured.last).toBe(1);

      await svc.recent(75);
      expect(captured.last).toBe(75);
    });
  });
});
