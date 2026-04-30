/**
 * P19x.8 (29/04/2026) — Real fees per venue avec breakdown JSON.
 *
 * Implémentation des grilles tarifaires officielles :
 *
 * IBKR Pro Tiered (US equities + ETFs)
 *   - Commission : $0.0035/share (avec rebates) ou $0.005/share (sans), min $0.35,
 *                  cap 1% trade value. On utilise $0.0035 (paper sim conservatif).
 *   - SEC fee (sell side US equities) : $27.80 par million de dollar value
 *   - TAF (FINRA Trading Activity Fee) : $0.000166/share, max $8.30 par exec (sell side)
 *   - Exchange fees : ~$0.001-0.003/share (varie par venue NYSE/NASDAQ/ARCA — moyenne $0.002)
 *
 * Binance spot crypto
 *   - Maker/taker : 0.1% (default — réduit à 0.075% si BNB pay)
 *   - Pas de SEC/TAF, pas de FX (USDT pair par défaut)
 *
 * IBKR Asia
 *   - KOSPI/KOSDAQ : 0.07% commission + 0.23% SST sell (Korea Securities Trans Tax)
 *   - NSE India : 0.015% commission + STT 0.025% sell + GST 18% sur commission
 *   - ASX : 0.005% commission
 *   - Tokyo : 0.05% commission
 *   - HK : 0.04% commission + 0.10% stamp duty + 0.005% SFC + 0.005% trading fee
 *
 * Note simplifiée pour paper sim : on utilise des aggregate ratios par asset class
 * + des ajustements explicites quand venue/side font une différence majeure
 * (e.g. SEC fee SELL US, stamp duty HK).
 *
 * Output schema cohérent pour persistence (JSONB lisa_positions.venue_fee_detail) :
 *   { commission: number, exchange: number, regulatory: number, fx: number, total: number }
 */

import Decimal from 'decimal.js';

export type Side = 'buy' | 'sell';

export interface VenueFeeBreakdown {
  /** Commission broker (IBKR Pro Tiered, Binance maker/taker, etc.) */
  commission: number;
  /** Exchange fees (NYSE/NASDAQ/ARCA + venue-specific HK stamp/SFC/trading fee) */
  exchange: number;
  /** Regulatory fees (SEC US sell, TAF, STT India, SST Korea sell) */
  regulatory: number;
  /** FX markup (cross-currency, IBKR ~0.2bp) — 0 si single-currency */
  fx: number;
  /** Total = commission + exchange + regulatory + fx */
  total: number;
}

/**
 * Calcule le breakdown des fees pour une transaction (entry ou exit).
 *
 * @param qty       quantité (shares / contracts / coins)
 * @param price     prix unitaire en USD (ou converted to USD pour non-USD venues)
 * @param assetClass  ex: 'us_equity_large', 'eu_equity', 'asia_equity', 'crypto_major', 'fx_g10'
 * @param venue     ex: 'NASDAQ', 'BINANCE', 'KO', 'HK', 'NSE', 'PA' — utilisé pour
 *                  les fees venue-specific (SST Korea, stamp HK, etc.)
 * @param side      'buy' (entry long, exit short) ou 'sell' (entry short, exit long).
 *                  Important pour SEC fee (sell only US), STT India (sell), etc.
 */
export function computeVenueFeeDetail(
  qty: Decimal,
  price: Decimal,
  assetClass: string | undefined,
  venue: string | undefined,
  side: Side,
): VenueFeeBreakdown {
  const zero: VenueFeeBreakdown = { commission: 0, exchange: 0, regulatory: 0, fx: 0, total: 0 };
  if (qty.lte(0) || price.lte(0)) return zero;

  const ac = (assetClass ?? '').toLowerCase();
  const v = (venue ?? '').toUpperCase();
  const notional = qty.mul(price);

  // ─── Crypto Binance ────────────────────────────────────────────────────────
  if (ac.startsWith('crypto')) {
    // Default taker 0.1% (aucune réduction BNB modelée — paper sim conservatif)
    const commission = notional.mul(0.001);
    return {
      commission: round2(commission),
      exchange: 0,
      regulatory: 0,
      fx: 0,
      total: round2(commission),
    };
  }

  // ─── Asia equities (KO, KQ, KS, NSE, BSE, AU, T, HK) ──────────────────────
  if (ac === 'asia_equity' || /^(KO|KQ|KS|NSE|BSE|AU|AX|T|TSE|HK|SS|SZ)$/.test(v)) {
    return computeAsiaFees(qty, price, v, side, notional);
  }

  // ─── EU equities ───────────────────────────────────────────────────────────
  if (ac === 'eu_equity' || /^(LSE|L|XETRA|DE|PA|AS|AMS|MI|SW|MC|BME)$/.test(v)) {
    // IBKR Pro EU : ~5bps moyenne all-in (commission + exchange combinés)
    const commission = notional.mul(0.0003); // 3bps
    const exchange = notional.mul(0.0002);   // 2bps exchange
    // FX markup léger si NOT EUR-quoted (paper sim assume USD reporting)
    const fx = notional.mul(0.00002); // 0.2bp
    const total = commission.plus(exchange).plus(fx);
    return {
      commission: round2(commission),
      exchange: round2(exchange),
      regulatory: 0,
      fx: round2(fx),
      total: round2(total),
    };
  }

  // ─── FX ────────────────────────────────────────────────────────────────────
  if (ac.startsWith('fx_')) {
    const commission = notional.mul(0.0001); // 1bp
    return {
      commission: round2(commission),
      exchange: 0,
      regulatory: 0,
      fx: 0,
      total: round2(commission),
    };
  }

  // ─── US equities + ETFs (default — IBKR Pro Tiered) ────────────────────────
  return computeUsFees(qty, price, side, notional);
}

function computeUsFees(qty: Decimal, _price: Decimal, side: Side, notional: Decimal): VenueFeeBreakdown {
  // Commission : max($0.35, $0.0035/share), capped 1% notional
  const perShareRate = new Decimal(0.0035);
  const minCommission = new Decimal(0.35);
  const maxCommission = notional.mul(0.01);
  let commission = Decimal.max(qty.mul(perShareRate), minCommission);
  if (commission.gt(maxCommission)) commission = maxCommission;

  // Exchange fees : ~$0.002/share moyenne (NYSE/NASDAQ/ARCA mix)
  const exchange = qty.mul(0.002);

  // Regulatory fees (US):
  //   - SEC fee (SELL only) : $27.80 per million dollar value (2024-2025 rate)
  //   - TAF (FINRA Trading Activity Fee, SELL only) : $0.000166/share, max $8.30
  let regulatory = new Decimal(0);
  if (side === 'sell') {
    const sec = notional.mul(27.80).dividedBy(1_000_000); // $27.80 / 1M
    let taf = qty.mul(0.000166);
    if (taf.gt(8.30)) taf = new Decimal(8.30);
    regulatory = sec.plus(taf);
  }

  const fx = new Decimal(0); // USD-quoted, no FX markup
  const total = commission.plus(exchange).plus(regulatory).plus(fx);
  return {
    commission: round4(commission),
    exchange: round4(exchange),
    regulatory: round4(regulatory),
    fx: round4(fx),
    total: round4(total),
  };
}

function computeAsiaFees(
  _qty: Decimal,
  _price: Decimal,
  v: string,
  side: Side,
  notional: Decimal,
): VenueFeeBreakdown {
  // Defaults : 5bps commission moyenne IBKR Asia + venue-specific regulatory
  let commission = notional.mul(0.0005);
  let exchange = new Decimal(0);
  let regulatory = new Decimal(0);

  if (v === 'KO' || v === 'KQ' || v === 'KS') {
    // Korea KOSPI/KOSDAQ — IBKR ~0.07% commission, SST 0.23% sell side only
    commission = notional.mul(0.0007);
    if (side === 'sell') {
      regulatory = notional.mul(0.0023); // KSST sell tax
    }
  } else if (v === 'NSE' || v === 'BSE') {
    // India — 0.015% commission, STT 0.025% sell, GST 18% on commission
    commission = notional.mul(0.00015);
    const gst = commission.mul(0.18);
    if (side === 'sell') {
      const stt = notional.mul(0.00025);
      regulatory = stt.plus(gst);
    } else {
      regulatory = gst;
    }
  } else if (v === 'HK') {
    // HK — 0.04% commission, 0.10% stamp duty (both sides), 0.005% SFC + 0.005% trading fee
    commission = notional.mul(0.0004);
    exchange = notional.mul(0.0001); // SFC + trading fee
    regulatory = notional.mul(0.001); // stamp duty
  } else if (v === 'AU' || v === 'AX') {
    commission = notional.mul(0.00005); // 0.5bp ASX
    exchange = notional.mul(0.00005);
  } else if (v === 'T' || v === 'TSE') {
    // Tokyo — 0.05% commission, no transaction tax
    commission = notional.mul(0.0005);
  } else if (v === 'SS' || v === 'SZ') {
    // China A-shares — 0.025% commission + 0.10% stamp duty sell only
    commission = notional.mul(0.00025);
    if (side === 'sell') {
      regulatory = notional.mul(0.001);
    }
  }

  const fx = notional.mul(0.00002); // 0.2bp FX markup (USD reporting)
  const total = commission.plus(exchange).plus(regulatory).plus(fx);
  return {
    commission: round4(commission),
    exchange: round4(exchange),
    regulatory: round4(regulatory),
    fx: round4(fx),
    total: round4(total),
  };
}

function round2(d: Decimal): number {
  return Math.round(d.toNumber() * 100) / 100;
}

function round4(d: Decimal): number {
  return Math.round(d.toNumber() * 10000) / 10000;
}
