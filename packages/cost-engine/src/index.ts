import Decimal from 'decimal.js';
import type { ExecutionQuality, FeeSchedule } from '@smartvest/domain';
import type { MoneyAmount } from '@smartvest/shared-types';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export interface TradeIntent {
  quantity: string;
  execPrice: string;
  benchmarkPrice?: string;
  fxRate?: string;
}

// Calcule la ventilation des frais d'une transaction en rendant visibles
// les frictions d'intermédiation (broker, spread, slippage, FX, taxes).
export function computeExecutionBreakdown(
  intent: TradeIntent,
  fees: FeeSchedule,
  taxes: MoneyAmount = '0',
): ExecutionQuality {
  const qty = new Decimal(intent.quantity);
  const price = new Decimal(intent.execPrice);
  const gross = qty.mul(price).abs();

  const fixed = new Decimal(fees.fixedPerOrder);
  const variable = gross.mul(new Decimal(fees.percentOfNotional).div(100));
  let brokerFee = fixed.plus(variable);
  if (fees.minPerOrder) brokerFee = Decimal.max(brokerFee, new Decimal(fees.minPerOrder));
  if (fees.maxPerOrder) brokerFee = Decimal.min(brokerFee, new Decimal(fees.maxPerOrder));

  const slippage = intent.benchmarkPrice
    ? qty.mul(price.minus(new Decimal(intent.benchmarkPrice))).abs()
    : new Decimal(0);

  const fxMarkup = intent.fxRate
    ? gross.mul(new Decimal(fees.fxMarkupPct).div(100))
    : new Decimal(0);

  const net = gross.plus(brokerFee).plus(slippage).plus(fxMarkup).plus(new Decimal(taxes));

  return {
    grossAmount: gross.toString(),
    brokerFee: brokerFee.toString(),
    exchangeFee: '0',
    taxes,
    spreadCost: '0',
    slippageCost: slippage.toString(),
    fxMarkup: fxMarkup.toString(),
    netAmount: net.toString(),
    feeCurrency: fees.currency,
    benchmarkPrice: intent.benchmarkPrice ?? null,
    benchmarkSource: intent.benchmarkPrice ? 'user_provided' : null,
  };
}
