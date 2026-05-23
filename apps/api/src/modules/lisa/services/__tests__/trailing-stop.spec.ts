/**
 * PR D — trailing-stop break-even helper.
 *
 * Constat data 15j (23/05/2026, n=20 stops avec peak tracking) :
 *   - MFE mean +0.48%, exit -1.98%, giveback +2.38% → ~$529 récupérables / 15j
 *
 * Helper pur — tests sans mock, déterministe.
 */

import { computeBreakEvenStopUpdate } from '../trailing-stop.helper';

describe('computeBreakEvenStopUpdate — LONG', () => {
  const baseArgs = { isLong: true, entry: 100, activationPct: 0.003, lockPct: 0.0005 };

  it('pas activé : peak < entry × 1.003 → null', () => {
    expect(computeBreakEvenStopUpdate({ ...baseArgs, peak: 100.20, currentStop: 99 })).toBeNull();
    expect(computeBreakEvenStopUpdate({ ...baseArgs, peak: 100.29, currentStop: 99 })).toBeNull();
  });

  it('activé : peak ≥ entry × 1.003 → stop monte à entry × 1.0005', () => {
    const r = computeBreakEvenStopUpdate({ ...baseArgs, peak: 100.30, currentStop: 99 });
    expect(r).toBeCloseTo(100.05);
  });

  it('peak très haut : stop reste à lock entry × 1.0005 (pas de trailing percent ici)', () => {
    const r = computeBreakEvenStopUpdate({ ...baseArgs, peak: 105, currentStop: 99 });
    expect(r).toBeCloseTo(100.05);
  });

  it('stop déjà ≥ lock → null (anti-spam, déjà appliqué)', () => {
    expect(computeBreakEvenStopUpdate({ ...baseArgs, peak: 101, currentStop: 100.05 })).toBeNull();
    expect(computeBreakEvenStopUpdate({ ...baseArgs, peak: 101, currentStop: 100.10 })).toBeNull();
  });

  it('stop null (jamais configuré) : applique le lock dès activation', () => {
    const r = computeBreakEvenStopUpdate({ ...baseArgs, peak: 100.5, currentStop: null });
    expect(r).toBeCloseTo(100.05);
  });

  it('inputs invalides → null (safe)', () => {
    expect(computeBreakEvenStopUpdate({ ...baseArgs, entry: 0, peak: 100, currentStop: null })).toBeNull();
    expect(computeBreakEvenStopUpdate({ ...baseArgs, entry: NaN, peak: 100, currentStop: null })).toBeNull();
    expect(computeBreakEvenStopUpdate({ ...baseArgs, peak: 0, currentStop: null })).toBeNull();
    expect(computeBreakEvenStopUpdate({ ...baseArgs, activationPct: 0, peak: 100, currentStop: null })).toBeNull();
    expect(computeBreakEvenStopUpdate({ ...baseArgs, activationPct: -0.01, peak: 100, currentStop: null })).toBeNull();
  });

  it('paramétrage agressif (activation 0.5%, lock 0.1%)', () => {
    const args = { isLong: true, entry: 100, activationPct: 0.005, lockPct: 0.001 };
    expect(computeBreakEvenStopUpdate({ ...args, peak: 100.40, currentStop: 99 })).toBeNull();
    expect(computeBreakEvenStopUpdate({ ...args, peak: 100.55, currentStop: 99 })!).toBeCloseTo(100.10);
  });
});

describe('computeBreakEvenStopUpdate — SHORT mirror', () => {
  const baseArgs = { isLong: false, entry: 100, activationPct: 0.003, lockPct: 0.0005 };

  it('pas activé : peak > entry × 0.997 → null', () => {
    expect(computeBreakEvenStopUpdate({ ...baseArgs, peak: 99.80, currentStop: 101 })).toBeNull();
    expect(computeBreakEvenStopUpdate({ ...baseArgs, peak: 99.75, currentStop: 101 })).toBeNull();
  });

  it('activé : peak ≤ entry × 0.997 → stop descend à entry × 0.9995', () => {
    const r = computeBreakEvenStopUpdate({ ...baseArgs, peak: 99.70, currentStop: 101 });
    expect(r).toBeCloseTo(99.95);
  });

  it('stop déjà ≤ lock → null (déjà appliqué côté short)', () => {
    expect(computeBreakEvenStopUpdate({ ...baseArgs, peak: 99, currentStop: 99.95 })).toBeNull();
    expect(computeBreakEvenStopUpdate({ ...baseArgs, peak: 99, currentStop: 99.50 })).toBeNull();
  });
});

describe('computeBreakEvenStopUpdate — invariants critiques', () => {
  it('long : si activation déclenché, nouveau stop est TOUJOURS au-dessus de entry (au moins de lockPct)', () => {
    for (let lock = 0; lock < 0.01; lock += 0.001) {
      const r = computeBreakEvenStopUpdate({
        isLong: true, entry: 100, peak: 110, currentStop: 50,
        activationPct: 0.003, lockPct: lock,
      });
      if (r !== null) expect(r).toBeGreaterThanOrEqual(100); // ≥ entry
    }
  });

  it('long : retour idempotent (appel répété → null après 1er update)', () => {
    const first = computeBreakEvenStopUpdate({
      isLong: true, entry: 100, peak: 101, currentStop: 99,
      activationPct: 0.003, lockPct: 0.0005,
    });
    expect(first).not.toBeNull();
    const second = computeBreakEvenStopUpdate({
      isLong: true, entry: 100, peak: 101, currentStop: first!,
      activationPct: 0.003, lockPct: 0.0005,
    });
    expect(second).toBeNull();
  });
});
