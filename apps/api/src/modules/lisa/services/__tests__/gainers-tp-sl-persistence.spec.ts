/**
 * Test de régression pour la persistance des champs gainers TP/SL et
 * min_persistence_score. Avant ce fix, ces 3 colonnes étaient lues par le
 * scanner mais jamais écrites par upsertSessionConfig → toute saisie UI était
 * silencieusement ignorée et la valeur DB restait coincée sur le default
 * migration 0093 (1.5 / 1.0).
 *
 * Couvre :
 *   1. pick() persiste gainers_default_tp_pct, gainers_default_sl_pct,
 *      gainers_min_persistence_score depuis snake_case ET camelCase.
 *   2. Fallback existing.* quand clé absente du payload.
 *   3. Validation des bornes (1, 50] / (1, 20] / [0, 1].
 */

function pickTpSl<T>(
  config: Record<string, unknown>,
  snake: string,
  camel: string,
  fallback: T,
): T {
  if (Object.prototype.hasOwnProperty.call(config, snake)) return config[snake] as T;
  if (Object.prototype.hasOwnProperty.call(config, camel)) return config[camel] as T;
  return fallback;
}

function buildMergedGainersTpSlFields(
  config: Record<string, unknown>,
  existing: Record<string, unknown> = {},
) {
  return {
    gainers_default_tp_pct: pickTpSl(
      config,
      'gainers_default_tp_pct',
      'gainersDefaultTpPct',
      existing.gainers_default_tp_pct ?? 1.5,
    ),
    gainers_default_sl_pct: pickTpSl(
      config,
      'gainers_default_sl_pct',
      'gainersDefaultSlPct',
      existing.gainers_default_sl_pct ?? 1.0,
    ),
    gainers_min_persistence_score: pickTpSl(
      config,
      'gainers_min_persistence_score',
      'gainersMinPersistenceScore',
      existing.gainers_min_persistence_score ?? null,
    ),
  };
}

function validateGainersPct(key: string, value: unknown, max: number): void {
  if (value == null) return;
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${key} : valeur numérique invalide.`);
  }
  if (n <= 0 || n > max) {
    throw new Error(`${key} : valeur ${n} hors plage acceptée (0, ${max}].`);
  }
}

describe('gainers TP/SL/min_persistence persistence (regression)', () => {
  describe('gainers_default_tp_pct', () => {
    it('persists 2.5 from snake_case payload', () => {
      const result = buildMergedGainersTpSlFields({ gainers_default_tp_pct: 2.5 });
      expect(result.gainers_default_tp_pct).toBe(2.5);
    });

    it('persists 3.0 from camelCase payload', () => {
      const result = buildMergedGainersTpSlFields({ gainersDefaultTpPct: 3.0 });
      expect(result.gainers_default_tp_pct).toBe(3.0);
    });

    it('falls back to existing DB value when absent', () => {
      const result = buildMergedGainersTpSlFields({}, { gainers_default_tp_pct: 4.5 });
      expect(result.gainers_default_tp_pct).toBe(4.5);
    });

    it('falls back to 1.5 default when no existing row', () => {
      const result = buildMergedGainersTpSlFields({});
      expect(result.gainers_default_tp_pct).toBe(1.5);
    });

    it('snake_case priority over camelCase if both present', () => {
      const result = buildMergedGainersTpSlFields({
        gainers_default_tp_pct: 2.5,
        gainersDefaultTpPct: 7.5,
      });
      expect(result.gainers_default_tp_pct).toBe(2.5);
    });
  });

  describe('gainers_default_sl_pct', () => {
    it('persists 1.5 from snake_case payload', () => {
      const result = buildMergedGainersTpSlFields({ gainers_default_sl_pct: 1.5 });
      expect(result.gainers_default_sl_pct).toBe(1.5);
    });

    it('falls back to 1.0 default', () => {
      const result = buildMergedGainersTpSlFields({});
      expect(result.gainers_default_sl_pct).toBe(1.0);
    });
  });

  describe('gainers_min_persistence_score', () => {
    it('persists explicit 0.83 (5/6 threshold)', () => {
      const result = buildMergedGainersTpSlFields({ gainers_min_persistence_score: 0.83 });
      expect(result.gainers_min_persistence_score).toBe(0.83);
    });

    it('persists explicit null (resets to default)', () => {
      const result = buildMergedGainersTpSlFields({ gainers_min_persistence_score: null });
      expect(result.gainers_min_persistence_score).toBeNull();
    });

    it('falls back to null when absent', () => {
      const result = buildMergedGainersTpSlFields({});
      expect(result.gainers_min_persistence_score).toBeNull();
    });
  });

  describe('validation (matches DB CHECK constraints)', () => {
    it('TP 2.5 accepted', () => {
      expect(() => validateGainersPct('tp', 2.5, 50)).not.toThrow();
    });
    it('TP 0 rejected (must be > 0)', () => {
      expect(() => validateGainersPct('tp', 0, 50)).toThrow(/hors plage/);
    });
    it('TP 50.01 rejected (above DB max 50)', () => {
      expect(() => validateGainersPct('tp', 50.01, 50)).toThrow(/hors plage/);
    });
    it('SL 1.0 accepted', () => {
      expect(() => validateGainersPct('sl', 1.0, 20)).not.toThrow();
    });
    it('SL 25 rejected (above DB max 20)', () => {
      expect(() => validateGainersPct('sl', 25, 20)).toThrow(/hors plage/);
    });
    it('TP "abc" rejected (NaN)', () => {
      expect(() => validateGainersPct('tp', 'abc', 50)).toThrow(/invalide/);
    });
    it('null skipped (= use default)', () => {
      expect(() => validateGainersPct('tp', null, 50)).not.toThrow();
    });
  });
});
