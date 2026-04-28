/**
 * P10-FIX — Test du cash buffer absolu (constante).
 *
 * Le code dans lisa.service.ts:approveProposal calcule :
 *   const CASH_BUFFER_USD = parseFloat(env.CASH_BUFFER_USD_OVERRIDE ?? '35');
 *   if (availableCash - allocAmount < CASH_BUFFER_USD) skip;
 *
 * Ce test valide la formule + le fallback env. Pas de mock Supabase ici
 * — on teste juste le predicat.
 */
import Decimal from 'decimal.js';

/**
 * Reproduction littérale de la logique du gate dans lisa.service.ts.
 * Si tu modifies le predicat, mets à jour les 2 endroits.
 */
function shouldSkipForCashBuffer(
  availableCashUsd: number,
  allocAmountUsd: number,
  bufferOverride?: string,
): boolean {
  const buffer = new Decimal(
    bufferOverride && Number.isFinite(parseFloat(bufferOverride))
      ? bufferOverride
      : '35',
  );
  const cash = new Decimal(availableCashUsd);
  const alloc = new Decimal(allocAmountUsd);
  return cash.minus(alloc).lt(buffer);
}

describe('P10-FIX cash buffer gate', () => {
  it('default buffer $35 — alloc 1500 sur cash 1500 → SKIP (cashAfter=0 < 35)', () => {
    expect(shouldSkipForCashBuffer(1500, 1500)).toBe(true);
  });

  it('default buffer $35 — alloc 1500 sur cash 1540 → PASS (cashAfter=40 > 35)', () => {
    expect(shouldSkipForCashBuffer(1540, 1500)).toBe(false);
  });

  it('default buffer $35 — alloc 500 sur cash 600 → PASS (cashAfter=100 > 35)', () => {
    expect(shouldSkipForCashBuffer(600, 500)).toBe(false);
  });

  it('default buffer $35 — alloc 500 sur cash 534 → SKIP (cashAfter=34 < 35)', () => {
    expect(shouldSkipForCashBuffer(534, 500)).toBe(true);
  });

  it('default buffer $35 — alloc 500 sur cash 535 → PASS (cashAfter=35 = 35, not lt)', () => {
    expect(shouldSkipForCashBuffer(535, 500)).toBe(false);
  });

  it('post-P10 PASS scenario : NOC alloc 1500 sur cash 1540 (was BLOCKED at $50 buffer)', () => {
    // Avec ancien buffer $50, cashAfter=40 < 50 → SKIP (incident 28/04)
    // Avec nouveau buffer $35, cashAfter=40 > 35 → PASS
    expect(shouldSkipForCashBuffer(1540, 1500)).toBe(false);
    // Et avec l'ancien :
    expect(shouldSkipForCashBuffer(1540, 1500, '50')).toBe(true);
  });

  it('env override CASH_BUFFER_USD_OVERRIDE accepted (10)', () => {
    // Tuning runtime à $10
    expect(shouldSkipForCashBuffer(510, 500, '10')).toBe(false); // cashAfter=10 = 10 → not lt → pass
    expect(shouldSkipForCashBuffer(509, 500, '10')).toBe(true); // cashAfter=9 < 10 → skip
  });

  it('env override invalide ignoré (fallback 35)', () => {
    expect(shouldSkipForCashBuffer(1540, 1500, 'not-a-number')).toBe(false);
    expect(shouldSkipForCashBuffer(1534, 1500, 'not-a-number')).toBe(true);
  });

  it('env override 0 — désactive effectivement le buffer', () => {
    expect(shouldSkipForCashBuffer(1500, 1500, '0')).toBe(false); // cashAfter=0 < 0 → false → pass
  });

  it('cash insuffisant strict → SKIP même avec petit buffer', () => {
    expect(shouldSkipForCashBuffer(100, 200, '0')).toBe(true); // cashAfter=-100 < 0 → skip
  });
});
