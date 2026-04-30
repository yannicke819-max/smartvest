/**
 * P20 (30/04/2026) — Tests for FEES-AWARE TARGET guard.
 *
 * Bug observed J-7 (2026-04-23 → 2026-04-29) : 9 trades closed_target avec
 * pct_move POSITIF (+0.003 % à +0.171 %) mais P&L NÉGATIF (-$0.92 à -$5.67).
 * Cause : TP en % < cost round-trip en %, fees dévorent le gain.
 *
 * Fix : reject open si gain attendu au TP < BUFFER × round-trip fees.
 *
 * Tests :
 *   1. resolveFeesAwareBuffer : env var parsing + clamp [1.0, 5.0]
 *   2. Formule directe (gain vs fees) — long et short, buffer 1.5/2.0/3.0
 *   3. Edge cases : qty très petite, prix très élevé, no TP (skip)
 *   4. Régression LMT @ $508 +0.019 % move (le bug réel)
 */

import Decimal from 'decimal.js';
import {
  computeVenueFeeDetail,
  computeRealisticFee,
  resolveFeesAwareBuffer,
} from '@smartvest/ai-analyst';

describe('resolveFeesAwareBuffer — P20 env var parsing', () => {
  const ORIGINAL_ENV = process.env.FEES_AWARE_BUFFER;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.FEES_AWARE_BUFFER;
    else process.env.FEES_AWARE_BUFFER = ORIGINAL_ENV;
  });

  it('returns default 2.0 when env unset', () => {
    delete process.env.FEES_AWARE_BUFFER;
    expect(resolveFeesAwareBuffer().toNumber()).toBe(2.0);
  });

  it('returns env value when valid (3.0)', () => {
    process.env.FEES_AWARE_BUFFER = '3.0';
    expect(resolveFeesAwareBuffer().toNumber()).toBe(3.0);
  });

  it('clamps env value to [1.0, 5.0] (lower bound)', () => {
    process.env.FEES_AWARE_BUFFER = '0.5';
    expect(resolveFeesAwareBuffer().toNumber()).toBe(1.0);
  });

  it('clamps env value to [1.0, 5.0] (upper bound)', () => {
    process.env.FEES_AWARE_BUFFER = '7.5';
    expect(resolveFeesAwareBuffer().toNumber()).toBe(5.0);
  });

  it('returns default 2.0 when env is malformed', () => {
    process.env.FEES_AWARE_BUFFER = 'not_a_number';
    expect(resolveFeesAwareBuffer().toNumber()).toBe(2.0);
  });

  it('parses fractional values (1.75)', () => {
    process.env.FEES_AWARE_BUFFER = '1.75';
    expect(resolveFeesAwareBuffer().toNumber()).toBe(1.75);
  });
});

/**
 * Helper : reproduit la formule du guard en mode pure pour test isolé.
 * Match l'implémentation paper-broker.service.ts et mechanical-trading.service.ts.
 */
function checkFeesAwareGuard(params: {
  entryPrice: number;
  tpPrice: number;
  qty: number;
  assetClass: string;
  venue: string;
  direction: 'long' | 'short';
  buffer: number;
}): { passes: boolean; expectedGain: number; roundTripFees: number; required: number } {
  const { entryPrice, tpPrice, qty, assetClass, venue, direction, buffer } = params;
  const isLong = direction === 'long';
  const exitSide: 'buy' | 'sell' = isLong ? 'sell' : 'buy';
  const entryFee = computeVenueFeeDetail(
    new Decimal(qty), new Decimal(entryPrice), assetClass, venue, 'buy',
  );
  const exitFee = computeVenueFeeDetail(
    new Decimal(qty), new Decimal(tpPrice), assetClass, venue, exitSide,
  );
  const roundTripFees = entryFee.total + exitFee.total;
  const expectedGain = isLong
    ? (tpPrice - entryPrice) * qty
    : (entryPrice - tpPrice) * qty;
  const required = roundTripFees * buffer;
  return { passes: expectedGain >= required, expectedGain, roundTripFees, required };
}

describe('FEES-AWARE TARGET guard — P20 formula', () => {
  describe('LMT regression — the actual bug case', () => {
    it('LMT @ $508 entry, qty=5, TP +0.019 % (~$508.10) → REJECTED at buffer 2.0', () => {
      // Bug réel : closed_target +$0.10/share gross × 5 = $0.50 gross,
      // fees IBKR Pro round-trip ~$0.70 → net -$0.20. Avec buffer 2.0
      // requis = $1.40. Reject attendu.
      const r = checkFeesAwareGuard({
        entryPrice: 508,
        tpPrice: 508 * 1.00019,
        qty: 5,
        assetClass: 'us_equity_large',
        venue: 'NASDAQ',
        direction: 'long',
        buffer: 2.0,
      });
      expect(r.passes).toBe(false);
      expect(r.expectedGain).toBeCloseTo(0.483, 1); // ~$0.48
      // entry fee : min $0.35 + exchange $0.01 = $0.36
      // exit fee  : min $0.35 + exchange $0.01 + SEC ~$0.07 + TAF ~$0.001 = ~$0.43
      // RT = ~$0.79, required = 2 × 0.79 = $1.58
      expect(r.roundTripFees).toBeCloseTo(0.79, 1);
      expect(r.required).toBeCloseTo(1.58, 1);
    });

    it('LMT @ $508 entry, qty=5, TP +0.5 % ($510.54) → PASSES at buffer 2.0', () => {
      // Avec un TP réaliste, gain = $2.54 × 5 = $12.70 >> $1.46 required.
      const r = checkFeesAwareGuard({
        entryPrice: 508,
        tpPrice: 508 * 1.005,
        qty: 5,
        assetClass: 'us_equity_large',
        venue: 'NASDAQ',
        direction: 'long',
        buffer: 2.0,
      });
      expect(r.passes).toBe(true);
      expect(r.expectedGain).toBeCloseTo(12.70, 1);
    });

    it('SLV @ $64 small notional qty=10, TP +0.05 % → REJECTED at buffer 2.0', () => {
      // P20 catch les cas évidents où gain au TP < 2× fees. Cas réel observé
      // SLV +0.008 % move = -$4.81 net. Le guard doit refuser si TP est
      // configuré trop serré.
      const r = checkFeesAwareGuard({
        entryPrice: 64.43,
        tpPrice: 64.43 * 1.0005,
        qty: 10,
        assetClass: 'us_equity_large',
        venue: 'NYSE',
        direction: 'long',
        buffer: 2.0,
      });
      // Gain : 10 × $0.032 = $0.32
      // RT fees : min $0.35 entry + ~$0.39 exit = ~$0.74 → required 1.48
      // 0.32 < 1.48 → REJECT ✓
      expect(r.passes).toBe(false);
      expect(r.expectedGain).toBeCloseTo(0.32, 1);
    });

    it('SLV qty=39 TP +0.171 % → PASSES P20 (gain $4.3 vs RT $0.93 × 2 = $1.86)', () => {
      // Note explicite : ce cas observé en prod (-$0.92 net) PASSE le guard P20
      // sur fees pures car gain > 2× venue fees. Le -$0.92 net réel venait de
      // slippage 5bps non modélé par le guard. P20 est un filet de sécurité,
      // pas un oracle parfait — il catch les cas évidents fees > gain.
      const r = checkFeesAwareGuard({
        entryPrice: 64.43,
        tpPrice: 64.43 * 1.00171,
        qty: 39,
        assetClass: 'us_equity_large',
        venue: 'NYSE',
        direction: 'long',
        buffer: 2.0,
      });
      expect(r.passes).toBe(true);
      expect(r.expectedGain).toBeCloseTo(4.30, 1);
    });
  });

  describe('Buffer sensitivity (1.5 vs 2.0 vs 3.0)', () => {
    // Setup : LMT $508, qty=5, TP +0.15 % → gain ≈ $3.81, RT fees ~$0.73
    const setup = {
      entryPrice: 508,
      tpPrice: 508 * 1.0015,
      qty: 5,
      assetClass: 'us_equity_large',
      venue: 'NASDAQ',
      direction: 'long' as const,
    };

    it('buffer 1.5 : 3.81 vs 1.5 × 0.73 = 1.10 → PASSES', () => {
      const r = checkFeesAwareGuard({ ...setup, buffer: 1.5 });
      expect(r.passes).toBe(true);
    });

    it('buffer 2.0 : 3.81 vs 2.0 × 0.73 = 1.46 → PASSES', () => {
      const r = checkFeesAwareGuard({ ...setup, buffer: 2.0 });
      expect(r.passes).toBe(true);
    });

    it('buffer 3.0 : 3.81 vs 3.0 × 0.73 = 2.19 → PASSES', () => {
      const r = checkFeesAwareGuard({ ...setup, buffer: 3.0 });
      expect(r.passes).toBe(true);
    });

    it('marginal case : LMT TP +0.05 % (gain $1.27), buffer 2.0 → REJECTED, buffer 1.5 → PASSES', () => {
      const m = {
        entryPrice: 508,
        tpPrice: 508 * 1.0005,
        qty: 5,
        assetClass: 'us_equity_large',
        venue: 'NASDAQ',
        direction: 'long' as const,
      };
      const r2 = checkFeesAwareGuard({ ...m, buffer: 2.0 });
      const r15 = checkFeesAwareGuard({ ...m, buffer: 1.5 });
      // gain ~ $1.27, RT fees ~$0.73
      // buffer 2.0 → required 1.46 > 1.27 → REJECTED
      expect(r2.passes).toBe(false);
      // buffer 1.5 → required 1.10 < 1.27 → PASSES
      expect(r15.passes).toBe(true);
    });
  });

  describe('Direction-aware (long vs short)', () => {
    it('SHORT : entry $100, TP $99 (1 % move down), qty=10 → gain = $10', () => {
      const r = checkFeesAwareGuard({
        entryPrice: 100,
        tpPrice: 99,
        qty: 10,
        assetClass: 'us_equity_large',
        venue: 'NASDAQ',
        direction: 'short',
        buffer: 2.0,
      });
      expect(r.passes).toBe(true);
      expect(r.expectedGain).toBeCloseTo(10, 1);
    });

    it('SHORT : TP above entry → expected_gain NEGATIVE → reject', () => {
      // Cas absurde mais doit être rejeté proprement (pas crash).
      const r = checkFeesAwareGuard({
        entryPrice: 100,
        tpPrice: 101,
        qty: 10,
        assetClass: 'us_equity_large',
        venue: 'NASDAQ',
        direction: 'short',
        buffer: 2.0,
      });
      expect(r.passes).toBe(false);
      expect(r.expectedGain).toBeLessThan(0);
    });
  });

  describe('Edge cases', () => {
    it('crypto venue (Binance 0.1 % taker, no SEC/TAF)', () => {
      // 0.1 BTC × $60k = $6k notional, TP +0.5 % = $30 gain
      // Fees : 0.1 % × $6000 buy + 0.1 % × $6030 sell = $6 + $6.03 = $12.03 RT
      // Required at 2.0 = $24.06 → gain $30 PASSES
      const r = checkFeesAwareGuard({
        entryPrice: 60000,
        tpPrice: 60300,
        qty: 0.1,
        assetClass: 'crypto_major',
        venue: 'BINANCE',
        direction: 'long',
        buffer: 2.0,
      });
      expect(r.passes).toBe(true);
      expect(r.expectedGain).toBeCloseTo(30, 1);
      expect(r.roundTripFees).toBeCloseTo(12.03, 1);
    });

    it('crypto with TP too tight (+0.15 %) → REJECTED', () => {
      // TP +0.15 % = $9 gain, RT fees ~$12 → required $24 → REJECTED
      const r = checkFeesAwareGuard({
        entryPrice: 60000,
        tpPrice: 60090,
        qty: 0.1,
        assetClass: 'crypto_major',
        venue: 'BINANCE',
        direction: 'long',
        buffer: 2.0,
      });
      expect(r.passes).toBe(false);
    });
  });
});

/**
 * Sanity test cross-check : confirme que computeRealisticFee (legacy) et
 * computeVenueFeeDetail (P19x.8) restent cohérents pour le min commission
 * IBKR US — c'est ce qu'on multiplie par 2 dans le guard.
 */
describe('Cross-check legacy fees vs venue breakdown — sanity', () => {
  it('US equity large 5 sh @ $508 : computeRealisticFee ~ commission part of computeVenueFeeDetail', () => {
    const realistic = computeRealisticFee(new Decimal(5), new Decimal(508), 'us_equity_large');
    const detail = computeVenueFeeDetail(new Decimal(5), new Decimal(508), 'us_equity_large', 'NASDAQ', 'buy');
    // computeRealisticFee retourne uniquement la commission (min $0.35).
    // computeVenueFeeDetail.commission = min $0.35 + cap aware. Doivent matcher.
    expect(realistic.toNumber()).toBeCloseTo(detail.commission, 2);
  });
});
