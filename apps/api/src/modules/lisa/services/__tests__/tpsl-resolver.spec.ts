import { resolveTpSlPcts } from '../tpsl-resolver';

/**
 * Priorité TP : (1) Lisa override → (2) matrice → (3) ATR×2 ≥ 4 % → floor 0.5
 * Priorité SL : (degraded ? 0.5×ATR14 : matrice → ATR×stopsMult) → floor 0.3
 */
const baseInput = {
  targetTakeProfitPct: null as number | null | undefined,
  matrixTpPct: null as number | null,
  matrixSlPct: null as number | null,
  atrStopPct: 1.0,
  stopsMult: 1.0,
  degradedActive: false,
  degradedAtr14Pct: null as number | null,
};

describe('resolveTpSlPcts — priorité TP', () => {
  it('priorité 1 : Lisa override gagne sur matrice et ATR', () => {
    const r = resolveTpSlPcts({ ...baseInput, targetTakeProfitPct: 5.5, matrixTpPct: 3.0 });
    expect(r.tpPct).toBe(5.5);
    expect(r.source.tp).toBe('lisa_override');
  });

  it('priorité 2 : matrice utilisée si Lisa null, ignore ATR×2', () => {
    const r = resolveTpSlPcts({ ...baseInput, matrixTpPct: 3.0, atrStopPct: 2.5 });
    expect(r.tpPct).toBe(3.0);
    expect(r.source.tp).toBe('matrix');
  });

  it('priorité 3 : ATR×2 ≥ 4 % si pas de Lisa ni matrice', () => {
    const r = resolveTpSlPcts({ ...baseInput, atrStopPct: 1.0 });
    expect(r.tpPct).toBe(4);
    expect(r.source.tp).toBe('atr_x2');
  });

  it('priorité 3 : ATR×2 utilisé tel quel si > 4 %', () => {
    const r = resolveTpSlPcts({ ...baseInput, atrStopPct: 3.0 });
    expect(r.tpPct).toBe(6);
  });

  it('floor 0.5 % : Lisa override 0.1 → clampé à 0.5', () => {
    const r = resolveTpSlPcts({ ...baseInput, targetTakeProfitPct: 0.1 });
    expect(r.tpPct).toBe(0.5);
    expect(r.source.tp).toBe('lisa_override');
  });

  it('floor 0.5 % : matrice 0.2 → clampé à 0.5', () => {
    const r = resolveTpSlPcts({ ...baseInput, matrixTpPct: 0.2 });
    expect(r.tpPct).toBe(0.5);
  });

  it('Lisa override undefined ignoré (fallback matrice)', () => {
    const r = resolveTpSlPcts({ ...baseInput, targetTakeProfitPct: undefined, matrixTpPct: 3.0 });
    expect(r.tpPct).toBe(3.0);
    expect(r.source.tp).toBe('matrix');
  });

  it('Lisa override NaN ignoré (fallback matrice)', () => {
    const r = resolveTpSlPcts({ ...baseInput, targetTakeProfitPct: NaN, matrixTpPct: 3.0 });
    expect(r.tpPct).toBe(3.0);
    expect(r.source.tp).toBe('matrix');
  });
});

describe('resolveTpSlPcts — priorité SL', () => {
  it('matrice gagne sur ATR (priorité 2)', () => {
    const r = resolveTpSlPcts({ ...baseInput, matrixSlPct: 1.3, atrStopPct: 2.0, stopsMult: 1.5 });
    expect(r.stopPct).toBe(1.3);
    expect(r.source.stop).toBe('matrix');
  });

  it('ATR×stopsMult utilisé si matrice absente (priorité 3)', () => {
    const r = resolveTpSlPcts({ ...baseInput, atrStopPct: 2.0, stopsMult: 1.5 });
    expect(r.stopPct).toBe(3.0);
    expect(r.source.stop).toBe('atr_derived');
  });

  it('floor 0.3 % : matrice 0.1 → clampé à 0.3', () => {
    const r = resolveTpSlPcts({ ...baseInput, matrixSlPct: 0.1 });
    expect(r.stopPct).toBe(0.3);
  });

  it('floor 0.3 % : ATR×stopsMult 0.1 → clampé à 0.3', () => {
    const r = resolveTpSlPcts({ ...baseInput, atrStopPct: 0.05, stopsMult: 1.0 });
    expect(r.stopPct).toBe(0.3);
  });
});

describe('resolveTpSlPcts — mode degraded (HORS_TRAJECTOIRE)', () => {
  it('degraded actif + ATR14 défini → 0.5×ATR14, ignore matrice', () => {
    const r = resolveTpSlPcts({
      ...baseInput,
      degradedActive: true,
      degradedAtr14Pct: 2.0,
      matrixSlPct: 1.3,
    });
    expect(r.stopPct).toBe(1.0);
    expect(r.source.stop).toBe('degraded_atr');
  });

  it('degraded actif + ATR14 null → tombe sur matrice / ATR (fail-soft)', () => {
    const r = resolveTpSlPcts({
      ...baseInput,
      degradedActive: true,
      degradedAtr14Pct: null,
      matrixSlPct: 1.3,
    });
    expect(r.stopPct).toBe(1.3);
    expect(r.source.stop).toBe('matrix');
  });

  it('degraded ne touche pas la priorité TP', () => {
    const r = resolveTpSlPcts({
      ...baseInput,
      degradedActive: true,
      degradedAtr14Pct: 2.0,
      matrixTpPct: 3.0,
    });
    expect(r.source.tp).toBe('matrix');
    expect(r.tpPct).toBe(3.0);
  });

  it('degraded ATR14 0.4 → clampé à 0.3 (floor)', () => {
    const r = resolveTpSlPcts({
      ...baseInput,
      degradedActive: true,
      degradedAtr14Pct: 0.4,
    });
    expect(r.stopPct).toBe(0.3);
  });
});

describe('resolveTpSlPcts — kill-switch matrix (QW_TPSL_MATRIX_ENABLED=false)', () => {
  // Côté caller, désactiver le flag = passer matrixTpPct/SlPct = null.
  it('matrix nulls → fallback total sur Lisa/ATR comme avant PR-2', () => {
    const r = resolveTpSlPcts({
      ...baseInput,
      matrixTpPct: null,
      matrixSlPct: null,
      atrStopPct: 1.5,
      stopsMult: 1.2,
    });
    expect(r.source.tp).toBe('atr_x2');
    expect(r.source.stop).toBe('atr_derived');
    expect(r.stopPct).toBeCloseTo(1.8, 10);
    expect(r.tpPct).toBe(4); // Math.max(3, 4)
  });
});

describe('resolveTpSlPcts — robustesse asset_class absent', () => {
  it('asset_class non listé → matrice null → no crash, fallback ATR', () => {
    const r = resolveTpSlPcts({
      ...baseInput,
      atrStopPct: 1.0,
      stopsMult: 1.0,
      matrixTpPct: null,
      matrixSlPct: null,
    });
    expect(r.tpPct).toBe(4);
    expect(r.stopPct).toBe(1.0);
  });
});
