/**
 * P19u (29/04/2026) — Tests for the realistic IBKR Pro fee model.
 *
 * Bug observed in prod : 7 trades all TP_HIT with exit > entry, gross calculé
 * +$4.74, net affiché -$27.84 → écart de -$32.58 de fees fictifs (10bps × 2
 * sides = 0.20% round-trip = 100x IBKR Pro réel).
 *
 * Le fix introduit `computeRealisticFee(qty, price, assetClass)` qui modélise
 * le tarif réel IBKR Pro Tiered :
 *   - US equities + ETFs : max($0.35, $0.005/share), capped à 1% × notional
 *   - EU/Asia equities   : 5bps × notional (proxy)
 *   - Crypto             : 0.085% × notional
 *   - FX                 : 1bp × notional
 *   - Default            : 5bps × notional
 */

import Decimal from 'decimal.js';
import { computeRealisticFee } from '@smartvest/ai-analyst';

describe('computeRealisticFee — P19u IBKR Pro Tiered model', () => {
  describe('US equities (default)', () => {
    it('charges $0.005/share when above min $0.35 threshold', () => {
      // 100 shares × $0.005 = $0.50 (above $0.35 min)
      const fee = computeRealisticFee(new Decimal(100), new Decimal(50), 'us_equity_large');
      expect(fee.toNumber()).toBeCloseTo(0.50, 2);
    });

    it('applies $0.35 minimum for small qty', () => {
      // 10 shares × $0.005 = $0.05 → bumped to $0.35 min
      const fee = computeRealisticFee(new Decimal(10), new Decimal(50), 'us_equity_small_mid');
      expect(fee.toNumber()).toBeCloseTo(0.35, 2);
    });

    it('caps at 1% of notional for tiny notionals (e.g. 1 share at $5)', () => {
      // 1 share × $5 = $5 notional. Min would be $0.35, but 1% = $0.05 → capped.
      const fee = computeRealisticFee(new Decimal(1), new Decimal(5), 'us_equity_small_mid');
      expect(fee.toNumber()).toBeCloseTo(0.05, 2);
    });

    it('LMT regression — 4.9159 shares at $508 should cost ~$0.35 (min), NOT ~$2.50', () => {
      // Le bug observé : 4.9159 × $508 ≈ $2497 → ancien fee 10bps = $2.50.
      // Nouveau : 4.9159 × $0.005 = $0.0246 → bumped à $0.35 min.
      // Round-trip $0.70 vs ancien $5.00 (-86% fees, dans la marge IBKR réel).
      const fee = computeRealisticFee(new Decimal(4.9159), new Decimal(508.16), 'us_equity_large');
      expect(fee.toNumber()).toBeCloseTo(0.35, 2);
    });

    it('SLV regression — 38.7582 shares at $64.43 should cost ~$0.35, NOT ~$2.50', () => {
      // 38.7582 × $0.005 = $0.194 → bumped à $0.35 min.
      // Notional ≈ $2497. 1% cap = $24.97. So fee = $0.35.
      const fee = computeRealisticFee(new Decimal(38.7582), new Decimal(64.43), 'us_equity_large');
      expect(fee.toNumber()).toBeCloseTo(0.35, 2);
    });

    it('per-share takes over above 70 shares threshold', () => {
      // 70 × $0.005 = $0.35 (boundary). 71 shares → $0.355 above min.
      expect(computeRealisticFee(new Decimal(70), new Decimal(50), 'us_equity_large').toNumber()).toBeCloseTo(0.35, 3);
      expect(computeRealisticFee(new Decimal(71), new Decimal(50), 'us_equity_large').toNumber()).toBeCloseTo(0.355, 3);
    });
  });

  describe('Crypto', () => {
    it('uses 0.085% × notional (Paxos average)', () => {
      // 0.1 BTC × $60000 = $6000 → 0.00085 × 6000 = $5.10
      const fee = computeRealisticFee(new Decimal(0.1), new Decimal(60000), 'crypto_major');
      expect(fee.toNumber()).toBeCloseTo(5.10, 2);
    });

    it('crypto_alt uses same 0.085% rate', () => {
      const fee = computeRealisticFee(new Decimal(1000), new Decimal(0.5), 'crypto_alt');
      // notional = $500 → 0.00085 × 500 = $0.425
      expect(fee.toNumber()).toBeCloseTo(0.425, 3);
    });
  });

  describe('EU + Asia equities', () => {
    it('eu_equity uses 5bps proxy', () => {
      // 100 × $50 = $5000 → 0.0005 × 5000 = $2.50
      const fee = computeRealisticFee(new Decimal(100), new Decimal(50), 'eu_equity');
      expect(fee.toNumber()).toBeCloseTo(2.50, 2);
    });

    it('asia_equity uses 5bps proxy', () => {
      const fee = computeRealisticFee(new Decimal(100), new Decimal(100), 'asia_equity');
      expect(fee.toNumber()).toBeCloseTo(5.00, 2);
    });

    it('KOSDAQ (.KQ) sell adds 0.18% Securities Transaction Tax (KR)', () => {
      // $3000 notional, sell side : 5bps + 18bps = 23bps = $6.90
      const fee = computeRealisticFee(new Decimal(100), new Decimal(30), 'asia_equity', '241520.KQ', 'sell');
      expect(fee.toNumber()).toBeCloseTo(6.90, 2);
    });

    it('KOSDAQ (.KQ) buy = NO STT (only 5bps commission)', () => {
      const fee = computeRealisticFee(new Decimal(100), new Decimal(30), 'asia_equity', '241520.KQ', 'buy');
      expect(fee.toNumber()).toBeCloseTo(1.50, 2);
    });

    it('KSE (.KO) sell adds 0.18% STT (same as KOSDAQ)', () => {
      const fee = computeRealisticFee(new Decimal(100), new Decimal(30), 'asia_equity', '005930.KO', 'sell');
      expect(fee.toNumber()).toBeCloseTo(6.90, 2);
    });

    it('HK (.HK) adds 0.10% stamp duty on BOTH sides', () => {
      // $3000 × (0.0005 + 0.001) = $4.50
      const feeBuy = computeRealisticFee(new Decimal(100), new Decimal(30), 'asia_equity', '0700.HK', 'buy');
      const feeSell = computeRealisticFee(new Decimal(100), new Decimal(30), 'asia_equity', '0700.HK', 'sell');
      expect(feeBuy.toNumber()).toBeCloseTo(4.50, 2);
      expect(feeSell.toNumber()).toBeCloseTo(4.50, 2);
    });

    it('UK (.LSE) buy adds 0.50% Stamp Duty (Reserve Tax)', () => {
      // $3000 × (0.0005 + 0.005) = $16.50
      const fee = computeRealisticFee(new Decimal(100), new Decimal(30), 'eu_equity', 'BARC.LSE', 'buy');
      expect(fee.toNumber()).toBeCloseTo(16.50, 2);
    });

    it('UK (.LSE) sell = NO stamp duty (only 5bps commission)', () => {
      const fee = computeRealisticFee(new Decimal(100), new Decimal(30), 'eu_equity', 'BARC.LSE', 'sell');
      expect(fee.toNumber()).toBeCloseTo(1.50, 2);
    });

    it('UK short .L suffix also detected', () => {
      const fee = computeRealisticFee(new Decimal(100), new Decimal(30), 'eu_equity', 'TSCO.L', 'buy');
      expect(fee.toNumber()).toBeCloseTo(16.50, 2);
    });

    it('backward compat : no symbol/side → no tax overlay', () => {
      // Le old caller pattern (qty, price, ac) doit retourner 5bps comme avant
      const fee = computeRealisticFee(new Decimal(100), new Decimal(30), 'asia_equity');
      expect(fee.toNumber()).toBeCloseTo(1.50, 2);
    });
  });

  describe('FX + commodity', () => {
    it('fx_major uses 1bp', () => {
      // 100k EUR × 1.10 USD = $110k → 0.0001 × 110000 = $11
      const fee = computeRealisticFee(new Decimal(100_000), new Decimal(1.10), 'fx_major');
      expect(fee.toNumber()).toBeCloseTo(11.0, 1);
    });

    it('commodity uses 5bps', () => {
      const fee = computeRealisticFee(new Decimal(10), new Decimal(2000), 'commodity');
      expect(fee.toNumber()).toBeCloseTo(10.0, 2);
    });
  });

  describe('Defensive cases', () => {
    it('returns 0 for invalid qty', () => {
      expect(computeRealisticFee(new Decimal(0), new Decimal(100), 'us_equity_large').toNumber()).toBe(0);
      expect(computeRealisticFee(new Decimal(-1), new Decimal(100), 'us_equity_large').toNumber()).toBe(0);
    });

    it('returns 0 for invalid price', () => {
      expect(computeRealisticFee(new Decimal(10), new Decimal(0), 'us_equity_large').toNumber()).toBe(0);
    });

    it('handles undefined assetClass with US equity per-share default', () => {
      // Default = US Pro Tiered: 100 × $0.005 = $0.50
      const fee = computeRealisticFee(new Decimal(100), new Decimal(50), undefined);
      expect(fee.toNumber()).toBeCloseTo(0.50, 2);
    });

    it('handles unknown assetClass with US equity per-share default', () => {
      const fee = computeRealisticFee(new Decimal(100), new Decimal(50), 'unknown_class_xyz');
      expect(fee.toNumber()).toBeCloseTo(0.50, 2);
    });
  });

  describe('Comparison vs old bps model (regression evidence)', () => {
    it('LMT round-trip : new ~$0.70 vs old $5.00 (~7x cheaper)', () => {
      const qty = new Decimal(4.9159);
      const price = new Decimal(508.16);
      const oldFee = qty.mul(price).mul(10).dividedBy(10000); // 10bps
      const newFee = computeRealisticFee(qty, price, 'us_equity_large');
      const oldRoundTrip = oldFee.mul(2);
      const newRoundTrip = newFee.mul(2);
      expect(oldRoundTrip.toNumber()).toBeGreaterThan(4.9);  // ~$5.00
      expect(newRoundTrip.toNumber()).toBeLessThan(1.0);     // ~$0.70 (2x min $0.35)
      // Ratio
      expect(oldRoundTrip.dividedBy(newRoundTrip).toNumber()).toBeGreaterThan(5);
    });

    it('SLV round-trip : new ~$0.70 vs old $5.00', () => {
      const qty = new Decimal(38.7582);
      const price = new Decimal(64.43);
      const newFee = computeRealisticFee(qty, price, 'us_equity_large');
      expect(newFee.mul(2).toNumber()).toBeLessThan(1.0);
    });
  });
});
