import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export interface FrictionEstimate {
  brokerFee: string;
  slippageCost: string;
  fxMarkup: string;
  total: string;
  currency: string;
}

/**
 * Estimates friction for a proposed trade using conservative assumptions.
 *
 * Intentionally does NOT import from @smartvest/cost-engine to keep this module
 * self-contained and testable. The cost-engine is used for actual execution pricing;
 * here we only need order-of-magnitude estimates for the review UI.
 *
 * Assumptions (typical low-cost online broker, EUR-denominated portfolio):
 *   - broker fee: 0.10% of notional, min 2 EUR
 *   - slippage:   0.20% of notional
 *   - FX markup:  0.50% if cross-currency trade
 */
@Injectable()
export class FrictionEstimatorService {
  estimate(notional: string | undefined, hasFxConversion = false): FrictionEstimate | null {
    if (!notional) return null;
    const n = new Decimal(notional);
    if (n.lte(0)) return null;

    const brokerFee = Decimal.max(new Decimal('2.00'), n.mul('0.001'));
    const slippage = n.mul('0.002');
    const fxMarkup = hasFxConversion ? n.mul('0.005') : new Decimal('0');
    const total = brokerFee.add(slippage).add(fxMarkup);

    return {
      brokerFee: brokerFee.toFixed(4),
      slippageCost: slippage.toFixed(4),
      fxMarkup: fxMarkup.toFixed(4),
      total: total.toFixed(4),
      currency: 'EUR',
    };
  }
}
