/**
 * P19x.8 (29/04/2026) — Tests pour computeVenueFeeDetail.
 *
 * Snapshots calculés à la main depuis les grilles tarifaires officielles :
 *   - IBKR Pro Tiered (US equities) : commission $0.0035/share min $0.35,
 *     SEC fee sell $27.80/M, TAF sell $0.000166/share max $8.30,
 *     exchange ~$0.002/share
 *   - Binance spot crypto : 0.1% taker
 *   - Korea KOSPI : 0.07% commission + 0.23% SST sell only
 *   - HK : 0.04% commission + 0.10% stamp + 0.01% SFC/trading fee
 *   - NSE India : 0.015% commission + 0.025% STT sell + 18% GST
 */

import Decimal from 'decimal.js';
import { computeVenueFeeDetail } from '@smartvest/ai-analyst';

describe('computeVenueFeeDetail — P19x.8 real fees per venue', () => {
  describe('US equities (IBKR Pro Tiered)', () => {
    it('BUY side: commission + exchange, no SEC/TAF', () => {
      // 100 shares × $50 = $5000 notional
      // Commission : max(100 × $0.0035, $0.35) = max($0.35, $0.35) = $0.35
      // Exchange : 100 × $0.002 = $0.20
      // Regulatory : 0 (BUY)
      // Total : $0.55
      const r = computeVenueFeeDetail(new Decimal(100), new Decimal(50), 'us_equity_large', 'NASDAQ', 'buy');
      expect(r.commission).toBeCloseTo(0.35, 2);
      expect(r.exchange).toBeCloseTo(0.20, 2);
      expect(r.regulatory).toBeCloseTo(0, 4);
      expect(r.fx).toBe(0);
      expect(r.total).toBeCloseTo(0.55, 2);
    });

    it('SELL side: adds SEC fee + TAF', () => {
      // 100 shares × $50 = $5000 notional
      // SEC fee : $5000 × $27.80 / 1M = $0.139
      // TAF : 100 × $0.000166 = $0.0166
      // Regulatory : $0.156
      const r = computeVenueFeeDetail(new Decimal(100), new Decimal(50), 'us_equity_large', 'NASDAQ', 'sell');
      expect(r.commission).toBeCloseTo(0.35, 2);
      expect(r.exchange).toBeCloseTo(0.20, 2);
      expect(r.regulatory).toBeCloseTo(0.156, 2);
      expect(r.total).toBeCloseTo(0.706, 2);
    });

    it('LMT regression : 5 shares @ $508 BUY, expected ~$0.36', () => {
      // 5 × $0.0035 = $0.0175 → bumped to $0.35 min
      // Exchange : 5 × $0.002 = $0.01
      // Total BUY : $0.36
      const r = computeVenueFeeDetail(new Decimal(5), new Decimal(508), 'us_equity_large', 'NASDAQ', 'buy');
      expect(r.total).toBeCloseTo(0.36, 2);
    });

    it('LMT round-trip BUY+SELL ~$0.85 (vs old 20bps = $5.08)', () => {
      const buy = computeVenueFeeDetail(new Decimal(5), new Decimal(508), 'us_equity_large', 'NASDAQ', 'buy');
      const sell = computeVenueFeeDetail(new Decimal(5), new Decimal(508.50), 'us_equity_large', 'NASDAQ', 'sell');
      const roundTrip = buy.total + sell.total;
      expect(roundTrip).toBeLessThan(1.0);
      // Compare to old 20bps round-trip (5.08)
      const oldFee = 5 * 508.5 * 0.0020;
      expect(roundTrip / oldFee).toBeLessThan(0.2); // <20% du legacy
    });
  });

  describe('Binance crypto', () => {
    it('uses 0.1% taker fee', () => {
      // 0.1 BTC × $60000 = $6000 notional
      // Commission : $6000 × 0.001 = $6.00
      const r = computeVenueFeeDetail(new Decimal(0.1), new Decimal(60000), 'crypto_major', 'BINANCE', 'buy');
      expect(r.commission).toBeCloseTo(6.0, 2);
      expect(r.exchange).toBe(0);
      expect(r.regulatory).toBe(0);
      expect(r.total).toBeCloseTo(6.0, 2);
    });

    it('crypto_alt same 0.1% rate', () => {
      const r = computeVenueFeeDetail(new Decimal(1000), new Decimal(0.5), 'crypto_alt', 'BINANCE', 'sell');
      expect(r.total).toBeCloseTo(0.5, 2); // 1000 × 0.5 × 0.001
    });
  });

  describe('Korea KOSPI/KOSDAQ', () => {
    it('BUY : commission 0.07%, no regulatory', () => {
      // 100 shares × $50 = $5000 notional
      // Commission : $5000 × 0.0007 = $3.50
      // FX : $5000 × 0.00002 = $0.10
      const r = computeVenueFeeDetail(new Decimal(100), new Decimal(50), 'asia_equity', 'KO', 'buy');
      expect(r.commission).toBeCloseTo(3.50, 2);
      expect(r.regulatory).toBe(0);
      expect(r.fx).toBeCloseTo(0.10, 2);
      expect(r.total).toBeCloseTo(3.60, 2);
    });

    it('SELL : adds SST 0.23%', () => {
      // SST sell : $5000 × 0.0023 = $11.50
      const r = computeVenueFeeDetail(new Decimal(100), new Decimal(50), 'asia_equity', 'KQ', 'sell');
      expect(r.regulatory).toBeCloseTo(11.50, 2);
      expect(r.total).toBeCloseTo(15.10, 2); // 3.50 + 0 + 11.50 + 0.10
    });
  });

  describe('Hong Kong', () => {
    it('commission + stamp duty 0.10% both sides + SFC/trading fee', () => {
      // 1000 × $10 = $10,000
      // Commission : 0.04% = $4.00
      // Exchange (SFC + trading) : 0.01% = $1.00
      // Stamp duty : 0.10% = $10.00
      const r = computeVenueFeeDetail(new Decimal(1000), new Decimal(10), 'asia_equity', 'HK', 'buy');
      expect(r.commission).toBeCloseTo(4.0, 2);
      expect(r.exchange).toBeCloseTo(1.0, 2);
      expect(r.regulatory).toBeCloseTo(10.0, 2);
    });
  });

  describe('NSE India', () => {
    it('BUY : commission 0.015% + GST 18% on commission', () => {
      // 100 × $50 = $5000
      // Commission : 0.00015 × 5000 = $0.75
      // GST : 0.18 × 0.75 = $0.135
      const r = computeVenueFeeDetail(new Decimal(100), new Decimal(50), 'asia_equity', 'NSE', 'buy');
      expect(r.commission).toBeCloseTo(0.75, 2);
      expect(r.regulatory).toBeCloseTo(0.135, 2);
    });

    it('SELL : adds STT 0.025%', () => {
      const r = computeVenueFeeDetail(new Decimal(100), new Decimal(50), 'asia_equity', 'NSE', 'sell');
      // STT : $1.25 + GST $0.135 = $1.385
      expect(r.regulatory).toBeCloseTo(1.385, 2);
    });
  });

  describe('EU equities', () => {
    it('all-in 5bps + 0.2bp FX', () => {
      const r = computeVenueFeeDetail(new Decimal(100), new Decimal(50), 'eu_equity', 'PA', 'buy');
      // Total ~ 5.2bps × 5000 = $2.60
      expect(r.total).toBeCloseTo(2.60, 1);
    });
  });

  describe('Defensive', () => {
    it('returns zeros for invalid qty/price', () => {
      const z = computeVenueFeeDetail(new Decimal(0), new Decimal(100), 'us_equity_large', 'NASDAQ', 'buy');
      expect(z.total).toBe(0);
    });

    it('falls back to US Pro Tiered when assetClass undefined', () => {
      const r = computeVenueFeeDetail(new Decimal(100), new Decimal(50), undefined, undefined, 'buy');
      expect(r.commission).toBeCloseTo(0.35, 2); // min commission applied
    });
  });
});
