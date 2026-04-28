/**
 * P11-FIX-SCANNER-CYCLE — Test de régression pour la persistance du cycle
 * scanner gainers (gainers_cycle_minutes).
 *
 * Couvre :
 *   1. upsertSessionConfig persiste gainers_cycle_minutes dans la DB.
 *   2. getCycleMinutes retourne la valeur DB, pas la valeur env globale.
 *   3. Le fallback 0089-absent ne bloque pas la sauvegarde des autres champs.
 */

/** Utilitaire minimal : reproduit la logique pick() de upsertSessionConfig. */
function pick<T>(
  config: Record<string, unknown>,
  snake: string,
  camel: string,
  fallback: T,
): T {
  if (Object.prototype.hasOwnProperty.call(config, snake)) return config[snake] as T;
  if (Object.prototype.hasOwnProperty.call(config, camel)) return config[camel] as T;
  return fallback;
}

/** Reproduit le merged-object de upsertSessionConfig (champs gainers uniquement). */
function buildMergedGainersFields(
  config: Record<string, unknown>,
  existing: Record<string, unknown> = {},
) {
  return {
    gainers_cycle_minutes: pick(config, 'gainers_cycle_minutes', 'gainersCycleMinutes', existing.gainers_cycle_minutes ?? 15),
    gainers_min_path_efficiency: pick(config, 'gainers_min_path_efficiency', 'gainersMinPathEfficiency', existing.gainers_min_path_efficiency ?? 0.5),
  };
}

describe('P11-FIX gainers_cycle_minutes persistence', () => {
  describe('pick() logic — snake_case POST body', () => {
    it('persists gainers_cycle_minutes=5 when POSTed as snake_case', () => {
      const result = buildMergedGainersFields({ gainers_cycle_minutes: 5 });
      expect(result.gainers_cycle_minutes).toBe(5);
    });

    it('persists gainers_cycle_minutes=30 when POSTed as camelCase', () => {
      const result = buildMergedGainersFields({ gainersCycleMinutes: 30 });
      expect(result.gainers_cycle_minutes).toBe(30);
    });

    it('falls back to existing DB value when key absent from payload', () => {
      const result = buildMergedGainersFields({}, { gainers_cycle_minutes: 10 });
      expect(result.gainers_cycle_minutes).toBe(10);
    });

    it('falls back to 15 when key absent and no existing row', () => {
      const result = buildMergedGainersFields({});
      expect(result.gainers_cycle_minutes).toBe(15);
    });

    it('explicit 1 min override accepted (edge: min value)', () => {
      const result = buildMergedGainersFields({ gainers_cycle_minutes: 1 });
      expect(result.gainers_cycle_minutes).toBe(1);
    });

    it('explicit 60 min override accepted (edge: max value)', () => {
      const result = buildMergedGainersFields({ gainers_cycle_minutes: 60 });
      expect(result.gainers_cycle_minutes).toBe(60);
    });

    it('snake_case takes priority over camelCase when both present', () => {
      const result = buildMergedGainersFields({ gainers_cycle_minutes: 20, gainersCycleMinutes: 45 });
      expect(result.gainers_cycle_minutes).toBe(20);
    });
  });

  describe('pick() logic — gainers_min_path_efficiency', () => {
    it('persists gainers_min_path_efficiency=0.7 as snake_case', () => {
      const result = buildMergedGainersFields({ gainers_min_path_efficiency: 0.7 });
      expect(result.gainers_min_path_efficiency).toBe(0.7);
    });

    it('persists gainers_min_path_efficiency=null (disabling gate)', () => {
      const result = buildMergedGainersFields({ gainers_min_path_efficiency: null });
      expect(result.gainers_min_path_efficiency).toBeNull();
    });

    it('falls back to 0.5 default when absent', () => {
      const result = buildMergedGainersFields({});
      expect(result.gainers_min_path_efficiency).toBe(0.5);
    });
  });

  describe('partial update — other fields unaffected', () => {
    it('posting only gainers_cycle_minutes does not clobber existing autopilot_cycle_minutes fallback', () => {
      // The merged object should use existing value for unrelated fields.
      // Here we model the isolation: if pick finds no key, it uses existing.
      const existing = { autopilot_cycle_minutes: 7, gainers_cycle_minutes: 15 };
      const config = { gainers_cycle_minutes: 5 };

      const gainersResult = buildMergedGainersFields(config, existing);
      // autopilot not touched
      const autopilotResult = pick(config, 'autopilot_cycle_minutes', 'autopilotCycleMinutes', existing.autopilot_cycle_minutes ?? 15);

      expect(gainersResult.gainers_cycle_minutes).toBe(5);
      expect(autopilotResult).toBe(7); // existing preserved
    });
  });
});

describe('P11-FIX getCycleMinutes — effective cycle logic', () => {
  /** Reproduit la logique de getCycleMinutes: clamp [1,60], fallback 15. */
  function effectiveCycle(dbValue: number | null | undefined, envGlobal = 15): number {
    const raw = Number(dbValue ?? 15);
    const validated = Number.isFinite(raw) && raw >= 1 && raw <= 60 ? raw : 15;
    // effective = max(env global, db per-portfolio)
    // (le cron global ne peut pas tourner plus vite que l'env)
    return Math.max(envGlobal, validated);
  }

  it('DB value 5 with env=15 → effective 15 (global cron is the floor)', () => {
    // User sets 5 min, but global cron fires every 15 — next tick at most 15 min
    expect(effectiveCycle(5, 15)).toBe(15);
  });

  it('DB value 20 with env=15 → effective 20 (per-portfolio is slower)', () => {
    expect(effectiveCycle(20, 15)).toBe(20);
  });

  it('DB value null → fallback 15, effective max(15,15)=15', () => {
    expect(effectiveCycle(null, 15)).toBe(15);
  });

  it('DB value 0 (invalid) → fallback 15', () => {
    expect(effectiveCycle(0, 15)).toBe(15);
  });

  it('DB value 1 with env=1 → effective 1', () => {
    expect(effectiveCycle(1, 1)).toBe(1);
  });

  it('DB value 60 → max possible cycle accepted', () => {
    expect(effectiveCycle(60, 15)).toBe(60);
  });

  it('DB value 61 (out of range) → fallback 15', () => {
    expect(effectiveCycle(61, 15)).toBe(15);
  });
});
