import { BadRequestException } from '@nestjs/common';
import { AssetClassTpslService } from '../asset-class-tpsl.service';
import type { SupabaseService } from '../../../supabase/supabase.service';

interface ChainStub {
  rows?: Array<Record<string, unknown>> | null;
  selectError?: { message: string } | null;
  updateRow?: Record<string, unknown> | null;
  updateError?: { message: string } | null;
}

function makeSupabase(stub: ChainStub): SupabaseService {
  return {
    isReady: () => true,
    getClient: () => ({
      from: () => ({
        // list path : .select(...).order(...)
        select: (_cols: string, _opts?: unknown) => ({
          order: () => Promise.resolve({ data: stub.rows ?? null, error: stub.selectError ?? null }),
          eq: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: stub.updateRow ?? null, error: stub.updateError ?? null }),
            }),
          }),
        }),
        // update path : .update(payload).eq(...).select().single()
        update: () => ({
          eq: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: stub.updateRow ?? null, error: stub.updateError ?? null }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseService;
}

describe('AssetClassTpslService', () => {
  describe('list()', () => {
    it('retourne le tableau ordonné par asset_class', async () => {
      const rows = [
        { asset_class: 'asia_equity', tp_pct: 0.03, sl_pct: -0.013 },
        { asset_class: 'eu_equity', tp_pct: 0.025, sl_pct: -0.018 },
      ];
      const svc = new AssetClassTpslService(makeSupabase({ rows }));
      const result = await svc.list();
      expect(result).toHaveLength(2);
      expect(result[0].asset_class).toBe('asia_equity');
    });
  });

  describe('update() — clamps', () => {
    it('rejette tp_pct=0.15 (hors range)', async () => {
      const svc = new AssetClassTpslService(makeSupabase({}));
      await expect(
        svc.update('us_equity_large', { tp_pct: 0.15 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejette sl_pct=0.01 (positif)', async () => {
      const svc = new AssetClassTpslService(makeSupabase({}));
      await expect(
        svc.update('us_equity_large', { sl_pct: 0.01 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejette score_min_floor=10 (hors range)', async () => {
      const svc = new AssetClassTpslService(makeSupabase({}));
      await expect(
        svc.update('us_equity_large', { score_min_floor: 10 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejette warmup_min_override=200 (hors range)', async () => {
      const svc = new AssetClassTpslService(makeSupabase({}));
      await expect(
        svc.update('us_equity_large', { warmup_min_override: 200 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejette asset_class inconnue', async () => {
      const svc = new AssetClassTpslService(makeSupabase({}));
      await expect(
        svc.update('fx_major', { tp_pct: 0.02 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepte patch valide et retourne row updated', async () => {
      const updated = {
        asset_class: 'us_equity_large',
        tp_pct: 0.028,
        sl_pct: -0.014,
        warmup_min_override: 30,
        regime_filter_enabled: false,
        score_min_floor: 0.85,
        path_eff_floor: 0.6,
        notes: 'test',
        updated_at: new Date().toISOString(),
      };
      const svc = new AssetClassTpslService(makeSupabase({ updateRow: updated }));
      const result = await svc.update('us_equity_large', {
        tp_pct: 0.028,
        sl_pct: -0.014,
      });
      expect(result.tp_pct).toBe(0.028);
      expect(result.asset_class).toBe('us_equity_large');
    });
  });
});
