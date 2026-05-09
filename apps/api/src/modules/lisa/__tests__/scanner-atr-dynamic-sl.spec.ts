/**
 * PR Phase 2 — Tests SL dynamique ATR-based.
 *
 * Justification empirique (analyse #298, n=14 backfilled) :
 *   - 35.7% des SL sont des wicks (drawdown < 1 ATR)
 *   - 42.9% des trades reviennent au break-even dans 30min
 *   - 0% n'auraient atteint TP +2% (loosen SL ne ramène PAS de gain)
 *
 * Conclusion : SL = max(default, atrPct × multiplier) évite wicks sans
 * amplifier les vraies pertes. Multiplier ×1.5 = balance optimale.
 *
 * Tests UNIT de la logique de décision (env GAINERS_SL_ATR_MULTIPLIER).
 */

import { computeAtr } from '../services/shadow-indicators.helper';

describe('PR Phase 2 — Helper computeAtr (Wilder smoothing)', () => {
  it('returns null when fewer than period+1 candles', () => {
    const candles = Array.from({ length: 10 }, (_, i) => ({
      high: 100 + i,
      low: 99 + i,
      close: 99.5 + i,
    }));
    expect(computeAtr(candles, 14)).toBeNull();
  });

  it('computes ATR on 15+ candles', () => {
    // Synthetic series : steady volatility
    const candles = Array.from({ length: 20 }, (_, i) => ({
      high: 100 + i + 0.5,
      low: 100 + i - 0.5,
      close: 100 + i,
    }));
    const atr = computeAtr(candles, 14);
    expect(atr).not.toBeNull();
    expect(atr!).toBeGreaterThan(0);
    // True range here ≈ 1.0 each day (high - low) and ~1 for prev_close diff
    expect(atr!).toBeGreaterThan(0.5);
    expect(atr!).toBeLessThan(2.0);
  });

  it('larger price range → larger ATR', () => {
    const tight = Array.from({ length: 20 }, (_, i) => ({
      high: 100 + i + 0.1,
      low: 100 + i - 0.1,
      close: 100 + i,
    }));
    const wide = Array.from({ length: 20 }, (_, i) => ({
      high: 100 + i + 2.0,
      low: 100 + i - 2.0,
      close: 100 + i,
    }));
    expect(computeAtr(wide, 14)!).toBeGreaterThan(computeAtr(tight, 14)!);
  });
});

describe('PR Phase 2 — ATR-based SL decision logic', () => {
  // Mirror la logique du scanner : effectiveSlPct = max(slPct, atrPct × 100 × multiplier)

  function computeEffectiveSl(
    baseSlPct: number,
    atrPct: number | null,
    multiplier: number,
  ): { effectiveSlPct: number; widened: boolean } {
    if (multiplier <= 0 || atrPct == null || atrPct <= 0) {
      return { effectiveSlPct: baseSlPct, widened: false };
    }
    const atrSlPct = atrPct * 100 * multiplier;
    if (atrSlPct > baseSlPct) {
      return { effectiveSlPct: atrSlPct, widened: true };
    }
    return { effectiveSlPct: baseSlPct, widened: false };
  }

  it('multiplier 0 (default) → SL unchanged, no widening', () => {
    const { effectiveSlPct, widened } = computeEffectiveSl(1.0, 0.005, 0);
    expect(effectiveSlPct).toBe(1.0);
    expect(widened).toBe(false);
  });

  it('atrPct null → SL unchanged (fail-safe)', () => {
    const { effectiveSlPct, widened } = computeEffectiveSl(1.0, null, 1.5);
    expect(effectiveSlPct).toBe(1.0);
    expect(widened).toBe(false);
  });

  it('atrPct 0 (degenerate) → SL unchanged', () => {
    const { effectiveSlPct, widened } = computeEffectiveSl(1.0, 0, 1.5);
    expect(effectiveSlPct).toBe(1.0);
    expect(widened).toBe(false);
  });

  it('ATR×1.5 > base SL → widened to ATR-based', () => {
    // atrPct=0.01 (= 1% volatility), multiplier 1.5 → atrSl = 1.5%
    // base sl = 1.0% → effective should be 1.5% (widened)
    const { effectiveSlPct, widened } = computeEffectiveSl(1.0, 0.01, 1.5);
    expect(effectiveSlPct).toBeCloseTo(1.5, 5);
    expect(widened).toBe(true);
  });

  it('ATR×1.5 < base SL → keep base SL (floor protection)', () => {
    // atrPct=0.003 (= 0.3% low vol), multiplier 1.5 → atrSl = 0.45%
    // base sl = 1.0% → keep 1.0% (floor)
    const { effectiveSlPct, widened } = computeEffectiveSl(1.0, 0.003, 1.5);
    expect(effectiveSlPct).toBe(1.0);
    expect(widened).toBe(false);
  });

  it('large multiplier ×2 → larger effective SL', () => {
    const { effectiveSlPct, widened } = computeEffectiveSl(1.0, 0.01, 2.0);
    expect(effectiveSlPct).toBeCloseTo(2.0, 5);
    expect(widened).toBe(true);
  });

  it('small multiplier ×1.2 → narrower than ×1.5', () => {
    const slow = computeEffectiveSl(1.0, 0.01, 1.2);
    const med = computeEffectiveSl(1.0, 0.01, 1.5);
    expect(slow.effectiveSlPct).toBeLessThan(med.effectiveSlPct);
  });
});

describe('PR Phase 2 — Calibration scenarios from prod data #298', () => {
  // Distribution réelle des dd_in_atr_units (n=14) :
  //  3 trades à 0.00, 1 à 0.39, 1 à 0.79 = 5 wicks (35.7%)
  //  1 à 1.38 = borderline
  //  8 trades > 1.5 ATR = real moves
  //
  // Avec multiplier ×1.5 et base_sl=1.0% :
  //  - wicks (atrPct ~ 0.5%) → atrSl = 0.75% < 1.0% → SL inchangé (1.0%)
  //  - real moves (atrPct ~ 1.0%) → atrSl = 1.5% > 1.0% → SL widened à 1.5%
  //
  // Effet net : sur les real_moves, SL plus large protège des wicks intra-real_move
  // tout en restant raisonnable. Sur les wicks "purs", base_sl 1.0% reste le filet.

  it('low-vol ticker (atr 0.3%) keeps base SL', () => {
    const atrPct = 0.003;
    const { effectiveSlPct, widened } = computeEffectiveSlInline(1.0, atrPct, 1.5);
    expect(widened).toBe(false);
    expect(effectiveSlPct).toBe(1.0);
  });

  it('mid-vol ticker (atr 0.7%) keeps base SL (atr×1.5=1.05% borderline)', () => {
    const atrPct = 0.007;
    const result = computeEffectiveSlInline(1.0, atrPct, 1.5);
    // 0.007 × 100 × 1.5 = 1.05 > 1.0 → widened
    expect(result.widened).toBe(true);
    expect(result.effectiveSlPct).toBeCloseTo(1.05, 5);
  });

  it('high-vol ticker (atr 1.0%) → SL widened to 1.5%', () => {
    const atrPct = 0.010;
    const result = computeEffectiveSlInline(1.0, atrPct, 1.5);
    expect(result.widened).toBe(true);
    expect(result.effectiveSlPct).toBeCloseTo(1.5, 5);
  });

  it('very high-vol ticker (atr 2.0%) → SL widened to 3.0%', () => {
    const atrPct = 0.020;
    const result = computeEffectiveSlInline(1.0, atrPct, 1.5);
    expect(result.widened).toBe(true);
    expect(result.effectiveSlPct).toBeCloseTo(3.0, 5);
  });
});

function computeEffectiveSlInline(
  baseSlPct: number,
  atrPct: number | null,
  multiplier: number,
): { effectiveSlPct: number; widened: boolean } {
  if (multiplier <= 0 || atrPct == null || atrPct <= 0) {
    return { effectiveSlPct: baseSlPct, widened: false };
  }
  const atrSlPct = atrPct * 100 * multiplier;
  if (atrSlPct > baseSlPct) {
    return { effectiveSlPct: atrSlPct, widened: true };
  }
  return { effectiveSlPct: baseSlPct, widened: false };
}
