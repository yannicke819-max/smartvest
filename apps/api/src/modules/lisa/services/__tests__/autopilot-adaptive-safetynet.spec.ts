import { AdaptiveSafetyNet } from '../adaptive-safety-net';

/**
 * PATCH 4 (PR#4 P1) — backoff progressif du filet de garantie quand
 * le régime est stable, pour économiser les coûts API.
 *
 * Règles testées :
 *   0-1 stables  → baseMin
 *   2-4 stables  → max(15, base × 2)
 *   5-9 stables  → max(30, base × 4)
 *   10+ stables  → max(60, base × 8)
 *   onEventDetected() → reset à 0
 *   onCycleCompleted({ proposalsGenerated > 0 OR regimeChanged }) → reset à 0
 */
describe('AdaptiveSafetyNet — backoff régime stable (PATCH 4)', () => {
  it('returns baseMin when 0 stable cycles', () => {
    const a = new AdaptiveSafetyNet();
    expect(a.nextSafetyNetMin(7)).toBe(7);
  });

  it('returns baseMin when 1 stable cycle', () => {
    const a = new AdaptiveSafetyNet();
    a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    expect(a.nextSafetyNetMin(7)).toBe(7);
  });

  it('extends safety-net delay after N stable cycles (base 7)', () => {
    const a = new AdaptiveSafetyNet();
    // 3 cycles stables → niveau 1 : min(15, 14) = 14 (au-dessus du base 7)
    for (let i = 0; i < 3; i++) {
      a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    }
    expect(a.nextSafetyNetMin(7)).toBeGreaterThanOrEqual(14);
    // Reset après event
    a.onEventDetected();
    expect(a.nextSafetyNetMin(7)).toBe(7);
  });

  it('progressively backs off through 4 levels (base 7)', () => {
    const a = new AdaptiveSafetyNet();
    // Niveau 0 (0-1) → baseMin
    expect(a.nextSafetyNetMin(7)).toBe(7);

    // 2 stables → niveau 1 : min(15, 14) = 14
    a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    expect(a.nextSafetyNetMin(7)).toBe(14);

    // +3 → 5 stables → niveau 2 : min(30, 28) = 28
    a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    expect(a.nextSafetyNetMin(7)).toBe(28);

    // +5 → 10 stables → niveau 3 : min(60, 56) = 56
    for (let i = 0; i < 5; i++) {
      a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    }
    expect(a.nextSafetyNetMin(7)).toBe(56);
  });

  it('resets on proposal generated', () => {
    const a = new AdaptiveSafetyNet();
    for (let i = 0; i < 5; i++) {
      a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    }
    expect(a.nextSafetyNetMin(7)).toBe(28); // niveau 2

    // Cycle productif → reset
    a.onCycleCompleted({ proposalsGenerated: 2, regimeChanged: false });
    expect(a.nextSafetyNetMin(7)).toBe(7);
  });

  it('resets on regime change', () => {
    const a = new AdaptiveSafetyNet();
    for (let i = 0; i < 5; i++) {
      a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    }
    expect(a.getStableCount()).toBe(5);

    // Regime shift → reset même si pas de thèses
    a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: true });
    expect(a.getStableCount()).toBe(0);
    expect(a.nextSafetyNetMin(7)).toBe(7);
  });

  it('resets on event detected', () => {
    const a = new AdaptiveSafetyNet();
    for (let i = 0; i < 10; i++) {
      a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    }
    expect(a.nextSafetyNetMin(7)).toBe(56);

    a.onEventDetected();
    expect(a.getStableCount()).toBe(0);
    expect(a.nextSafetyNetMin(7)).toBe(7);
  });

  it('caps at level limits even with large base (base 30)', () => {
    const a = new AdaptiveSafetyNet();
    for (let i = 0; i < 15; i++) {
      a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    }
    // base 30 × 8 = 240, capé à 60
    expect(a.nextSafetyNetMin(30)).toBe(60);
  });

  it('respects min(level_cap, base × multiplier) on small base', () => {
    const a = new AdaptiveSafetyNet();
    // base 5, 2-4 stables → min(15, 5*2) = min(15, 10) = 10
    a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    a.onCycleCompleted({ proposalsGenerated: 0, regimeChanged: false });
    expect(a.nextSafetyNetMin(5)).toBe(10);
  });
});
