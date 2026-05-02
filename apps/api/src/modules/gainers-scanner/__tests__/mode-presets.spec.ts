/**
 * ADR-007 PR #207b — ModePresetsService unit tests.
 */

import { ModePresetsService } from '../presets/mode-presets.service';
import type { BuiltinPreset } from '../presets/types';

const FIXTURE_BUILTIN: any[] = [
  { id: '1', mode: 'INVESTMENT', preset_key: 'CONSERVATIVE', display_name: 'Conservateur', icon: '🛡️', description: 'Retraité', params: { stocks_pct: 20 }, source_ref: 'Schwab', warning_level: 'NONE', display_order: 1 },
  { id: '2', mode: 'INVESTMENT', preset_key: 'MODERATE', display_name: 'Modéré', icon: '⚖️', description: 'Mid-life', params: { stocks_pct: 50 }, source_ref: 'Vanguard', warning_level: 'NONE', display_order: 2 },
  { id: '3', mode: 'INVESTMENT', preset_key: 'GROWTH', display_name: 'Croissance', icon: '📈', description: 'Young', params: { stocks_pct: 75 }, source_ref: 'Bogleheads', warning_level: 'NONE', display_order: 3 },
  { id: '4', mode: 'INVESTMENT', preset_key: 'AGGRESSIVE_GROWTH', display_name: 'Agressif', icon: '🚀', description: 'High DD tolerance', params: { stocks_pct: 95 }, source_ref: 'Schwab Aggressive', warning_level: 'CAUTION', display_order: 4 },
  { id: '5', mode: 'GAINERS', preset_key: 'CONSERVATIVE', display_name: 'Conservateur', icon: '🛡️', description: 'Quarter-Kelly', params: { kelly_fraction: 0.25 }, source_ref: 'Thorp 1969', warning_level: 'NONE', display_order: 1 },
  { id: '6', mode: 'GAINERS', preset_key: 'MODERATE', display_name: 'Modéré', icon: '⚖️', description: 'Half-Kelly', params: { kelly_fraction: 0.50 }, source_ref: 'Cohen 2018', warning_level: 'NONE', display_order: 2 },
  { id: '7', mode: 'GAINERS', preset_key: 'AGGRESSIVE', display_name: 'Agressif', icon: '🔥', description: '3/4 Kelly', params: { kelly_fraction: 0.75 }, source_ref: 'kucoin', warning_level: 'CAUTION', display_order: 3 },
  { id: '8', mode: 'GAINERS', preset_key: 'KAMIKAZE', display_name: 'Kamikaze', icon: '☠️', description: 'Full Kelly', params: { kelly_fraction: 1.0 }, source_ref: 'Kelly 1956', warning_level: 'KAMIKAZE', display_order: 4 },
];

function makeMockSupabase(builtin = FIXTURE_BUILTIN, userPresets: any[] = []) {
  return {
    getClient: () => ({
      from: (table: string) => {
        const data = table === 'mode_presets_builtin' ? builtin : userPresets;
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
          then: (resolve: any) => resolve({ data, error: null }),
        };
        return chain;
      },
    }),
  } as any;
}

describe('ModePresetsService', () => {
  describe('listBuiltin()', () => {
    it('returns 4 presets for INVESTMENT in display_order', async () => {
      const svc = new ModePresetsService(makeMockSupabase());
      const presets = await svc.listBuiltin('INVESTMENT');
      expect(presets.length).toBe(4);
      expect(presets[0].presetKey).toBe('CONSERVATIVE');
      expect(presets[1].presetKey).toBe('MODERATE');
      expect(presets[2].presetKey).toBe('GROWTH');
      expect(presets[3].presetKey).toBe('AGGRESSIVE_GROWTH');
    });

    it('returns 4 presets for GAINERS', async () => {
      const svc = new ModePresetsService(makeMockSupabase());
      const presets = await svc.listBuiltin('GAINERS');
      expect(presets.length).toBe(4);
      expect(presets[0].presetKey).toBe('CONSERVATIVE');
      expect(presets[3].presetKey).toBe('KAMIKAZE');
      expect(presets[3].warningLevel).toBe('KAMIKAZE');
    });

    it('returns empty for HARVEST in this fixture (no rows)', async () => {
      const svc = new ModePresetsService(makeMockSupabase());
      const presets = await svc.listBuiltin('HARVEST');
      expect(presets).toEqual([]);
    });

    it('caches builtin (second call no DB hit)', async () => {
      let callCount = 0;
      const supabase = {
        getClient: () => ({
          from: () => {
            callCount++;
            const chain: any = {
              select: () => chain,
              order: () => chain,
              then: (r: any) => r({ data: FIXTURE_BUILTIN, error: null }),
            };
            return chain;
          },
        }),
      } as any;
      const svc = new ModePresetsService(supabase);
      await svc.listBuiltin('INVESTMENT');
      await svc.listBuiltin('INVESTMENT');
      await svc.listBuiltin('GAINERS');
      // Should only hit DB once (cache TTL 5min)
      expect(callCount).toBe(1);
    });
  });

  describe('getDefaultPreset()', () => {
    it('returns the MODERATE preset for INVESTMENT', async () => {
      const svc = new ModePresetsService(makeMockSupabase());
      const def = await svc.getDefaultPreset('INVESTMENT');
      expect(def?.presetKey).toBe('MODERATE');
    });

    it('returns the MODERATE preset for GAINERS', async () => {
      const svc = new ModePresetsService(makeMockSupabase());
      const def = await svc.getDefaultPreset('GAINERS');
      expect(def?.presetKey).toBe('MODERATE');
      expect((def?.params as any).kelly_fraction).toBe(0.5);
    });

    it('returns null if no presets', async () => {
      const svc = new ModePresetsService(makeMockSupabase([]));
      const def = await svc.getDefaultPreset('INVESTMENT');
      expect(def).toBeNull();
    });
  });

  describe('preset structure validation', () => {
    it('all 8 fixture presets have required fields', () => {
      for (const row of FIXTURE_BUILTIN) {
        expect(row.id).toBeDefined();
        expect(['INVESTMENT', 'HARVEST', 'GAINERS']).toContain(row.mode);
        expect(['CONSERVATIVE', 'MODERATE', 'GROWTH', 'AGGRESSIVE', 'AGGRESSIVE_GROWTH', 'SCALPER', 'KAMIKAZE']).toContain(row.preset_key);
        expect(row.display_name).toBeTruthy();
        expect(row.icon).toBeTruthy();
        expect(row.params).toBeDefined();
        expect(row.source_ref).toBeTruthy();
        expect(['NONE', 'CAUTION', 'KAMIKAZE']).toContain(row.warning_level);
      }
    });

    it('GAINERS KAMIKAZE preset has full Kelly + warning_level=KAMIKAZE', () => {
      const kamikaze = FIXTURE_BUILTIN.find((r) => r.mode === 'GAINERS' && r.preset_key === 'KAMIKAZE');
      expect(kamikaze).toBeDefined();
      expect(kamikaze.params.kelly_fraction).toBe(1.0);
      expect(kamikaze.warning_level).toBe('KAMIKAZE');
    });

    it('GAINERS MODERATE matches ADR-007 §3.2 default (half-Kelly)', () => {
      const moderate = FIXTURE_BUILTIN.find((r) => r.mode === 'GAINERS' && r.preset_key === 'MODERATE');
      expect(moderate).toBeDefined();
      expect(moderate.params.kelly_fraction).toBe(0.5);
      expect(moderate.warning_level).toBe('NONE');
    });
  });
});
