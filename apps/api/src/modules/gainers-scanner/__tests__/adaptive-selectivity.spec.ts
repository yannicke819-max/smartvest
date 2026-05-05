/**
 * PR #243 — Tests GainersAdaptiveSelectivityService.computeAdjustment.
 *
 * Couvre la logique pure (sans I/O Supabase) :
 *   - EN_AVANCE             → no_op
 *   - DANS_LE_PLAN + active  → restore from snapshot
 *   - DANS_LE_PLAN + !active → no_op
 *   - EN_RETARD first        → adjust + snapshot user values
 *   - EN_RETARD continued    → adjust without re-snapshot
 *   - EN_RETARD all at floor → no_op (cannot adjust further)
 *   - HORS_TRAJECTOIRE       → kill_switch + restore (if active)
 *   - HORS_TRAJECTOIRE !act  → kill_switch only
 *
 * Brackets ADR-005 testés : floors persistence/path/cooldown, ceiling max_per_cycle.
 */

import { GainersAdaptiveSelectivityService, type AdaptiveContext } from '../automations/adaptive-selectivity.service';

function makeService(): GainersAdaptiveSelectivityService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new GainersAdaptiveSelectivityService({} as any, { logInsight: jest.fn() } as any);
}

const baseCtx: AdaptiveContext = {
  current_persistence: 0.67,
  current_path_eff: 0.50,
  current_max_per_cycle: 3,
  current_cooldown: 30,
  snapshot_persistence: null,
  snapshot_path_eff: null,
  snapshot_max_per_cycle: null,
  snapshot_cooldown: null,
  adaptive_active: false,
};

describe('GainersAdaptiveSelectivityService.computeAdjustment', () => {
  describe('EN_AVANCE', () => {
    it('always no_op (preserve cap user)', () => {
      const svc = makeService();
      const decision = svc.computeAdjustment('EN_AVANCE', baseCtx);
      expect(decision.action).toBe('no_op');
      expect(decision.reason).toContain('preserve user cap');
    });
  });

  describe('DANS_LE_PLAN', () => {
    it('not active → no_op', () => {
      const svc = makeService();
      const decision = svc.computeAdjustment('DANS_LE_PLAN', baseCtx);
      expect(decision.action).toBe('no_op');
    });

    it('active → restore from snapshot', () => {
      const svc = makeService();
      const ctx: AdaptiveContext = {
        ...baseCtx,
        adaptive_active: true,
        current_persistence: 0.62,
        current_path_eff: 0.45,
        current_max_per_cycle: 4,
        current_cooldown: 15,
        snapshot_persistence: 0.67,
        snapshot_path_eff: 0.50,
        snapshot_max_per_cycle: 3,
        snapshot_cooldown: 30,
      };
      const decision = svc.computeAdjustment('DANS_LE_PLAN', ctx);
      expect(decision.action).toBe('restore');
      expect(decision.next_persistence).toBe(0.67);
      expect(decision.next_path_eff).toBe(0.50);
      expect(decision.next_max_per_cycle).toBe(3);
      expect(decision.next_cooldown).toBe(30);
      expect(decision.next_adaptive_active).toBe(false);
      // Clear snapshot
      expect(decision.next_snapshot_persistence).toBe(null);
    });
  });

  describe('EN_RETARD', () => {
    it('first transition → adjust + snapshot', () => {
      const svc = makeService();
      const decision = svc.computeAdjustment('EN_RETARD', baseCtx);
      expect(decision.action).toBe('adjust');
      expect(decision.next_persistence).toBeCloseTo(0.62, 3); // 0.67 - 0.05
      expect(decision.next_path_eff).toBeCloseTo(0.45, 3);    // 0.50 - 0.05
      expect(decision.next_max_per_cycle).toBe(4);            // 3 + 1
      expect(decision.next_cooldown).toBe(15);                // 30 / 2
      expect(decision.next_adaptive_active).toBe(true);
      // Snapshot user values
      expect(decision.next_snapshot_persistence).toBe(0.67);
      expect(decision.next_snapshot_path_eff).toBe(0.50);
      expect(decision.next_snapshot_max_per_cycle).toBe(3);
      expect(decision.next_snapshot_cooldown).toBe(30);
    });

    it('continued (already active) → adjust without re-snapshot', () => {
      const svc = makeService();
      const ctx: AdaptiveContext = {
        ...baseCtx,
        adaptive_active: true,
        current_persistence: 0.62,
        current_path_eff: 0.45,
        current_max_per_cycle: 4,
        current_cooldown: 15,
        snapshot_persistence: 0.67,
        snapshot_path_eff: 0.50,
        snapshot_max_per_cycle: 3,
        snapshot_cooldown: 30,
      };
      const decision = svc.computeAdjustment('EN_RETARD', ctx);
      expect(decision.action).toBe('adjust');
      expect(decision.next_persistence).toBeCloseTo(0.57, 3); // 0.62 - 0.05
      expect(decision.next_path_eff).toBeCloseTo(0.40, 3);    // 0.45 - 0.05
      expect(decision.next_max_per_cycle).toBe(5);            // 4 + 1
      expect(decision.next_cooldown).toBe(7);                 // floor(15/2)
      // No re-snapshot (snapshot fields not in decision)
      expect('next_snapshot_persistence' in decision).toBe(false);
    });

    it('clamp persistence floor 0.50', () => {
      const svc = makeService();
      const ctx: AdaptiveContext = {
        ...baseCtx,
        adaptive_active: true,
        current_persistence: 0.52,
        snapshot_persistence: 0.67,
      };
      const decision = svc.computeAdjustment('EN_RETARD', ctx);
      expect(decision.next_persistence).toBe(0.50); // clamped, not 0.47
    });

    it('clamp path floor 0.30', () => {
      const svc = makeService();
      const ctx: AdaptiveContext = {
        ...baseCtx,
        adaptive_active: true,
        current_path_eff: 0.32,
        snapshot_path_eff: 0.50,
      };
      const decision = svc.computeAdjustment('EN_RETARD', ctx);
      expect(decision.next_path_eff).toBe(0.30);
    });

    it('clamp max_per_cycle ceiling 10', () => {
      const svc = makeService();
      const ctx: AdaptiveContext = {
        ...baseCtx,
        adaptive_active: true,
        current_max_per_cycle: 10,
        snapshot_max_per_cycle: 3,
      };
      const decision = svc.computeAdjustment('EN_RETARD', ctx);
      expect(decision.next_max_per_cycle).toBe(10);
    });

    it('clamp cooldown floor 5', () => {
      const svc = makeService();
      const ctx: AdaptiveContext = {
        ...baseCtx,
        adaptive_active: true,
        current_cooldown: 8,
        snapshot_cooldown: 30,
      };
      const decision = svc.computeAdjustment('EN_RETARD', ctx);
      expect(decision.next_cooldown).toBe(5); // floor(8/2)=4 < 5 floor
    });

    it('all at floor → no_op (cannot adjust further)', () => {
      const svc = makeService();
      const ctx: AdaptiveContext = {
        ...baseCtx,
        adaptive_active: true,
        current_persistence: 0.50,
        current_path_eff: 0.30,
        current_max_per_cycle: 10,
        current_cooldown: 5,
      };
      const decision = svc.computeAdjustment('EN_RETARD', ctx);
      expect(decision.action).toBe('no_op');
      expect(decision.reason).toContain('floor');
    });
  });

  describe('HORS_TRAJECTOIRE', () => {
    it('not active → kill_switch only (autopilot OFF)', () => {
      const svc = makeService();
      const decision = svc.computeAdjustment('HORS_TRAJECTOIRE', baseCtx);
      expect(decision.action).toBe('kill_switch');
      expect(decision.next_autopilot_enabled).toBe(false);
      expect(decision.next_adaptive_active).toBe(false);
    });

    it('active → kill_switch + restore from snapshot', () => {
      const svc = makeService();
      const ctx: AdaptiveContext = {
        ...baseCtx,
        adaptive_active: true,
        current_persistence: 0.55,
        snapshot_persistence: 0.67,
        snapshot_path_eff: 0.50,
        snapshot_max_per_cycle: 3,
        snapshot_cooldown: 30,
      };
      const decision = svc.computeAdjustment('HORS_TRAJECTOIRE', ctx);
      expect(decision.action).toBe('kill_switch');
      expect(decision.next_autopilot_enabled).toBe(false);
      expect(decision.next_persistence).toBe(0.67); // restored
      expect(decision.next_adaptive_active).toBe(false);
    });
  });
});
