/**
 * Black-Scholes pricer pour calls et puts européens (sans dividende).
 *
 * Pour SmartVest sim, on n'a pas besoin de précision pro — un BS standard
 * suffit. Pas de surface de volatilité (on assume IV plate), pas de taux
 * sans risque non plat (constant 4% pour US10Y proxy).
 *
 * Conventions :
 *  - S : prix sous-jacent
 *  - K : strike
 *  - T : temps à expiration en années (jours / 365)
 *  - r : taux sans risque (default 0.04)
 *  - sigma : IV implicite (en fraction, 0.30 = 30%)
 *
 * Retourne le prix d'UN contrat (1 unité × 1 sous-jacent), pas × 100.
 * Le multiplicateur 100 est appliqué au niveau positionnel.
 */

const RISK_FREE_RATE = 0.04;

/** PDF normale standard. */
function normalPdf(x: number): number {
  return Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);
}

/** CDF normale standard via approximation Abramowitz & Stegun (~5e-7 erreur). */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const k = 1 / (1 + 0.2316419 * absX);
  const w =
    1 -
    normalPdf(absX) *
      (0.319381530 * k -
        0.356563782 * k ** 2 +
        1.781477937 * k ** 3 -
        1.821255978 * k ** 4 +
        1.330274429 * k ** 5);
  return 0.5 * (1 + sign * (2 * w - 1));
}

export interface BlackScholesInput {
  spot: number;
  strike: number;
  timeYears: number;
  iv: number;
  riskFreeRate?: number;
}

export interface BlackScholesOutput {
  callPrice: number;
  putPrice: number;
  callDelta: number;
  putDelta: number;
  /** Theta en par-jour (négatif pour long), USD pour 1 sous-jacent (×100 pour contrat). */
  callTheta: number;
  putTheta: number;
}

export function blackScholes(input: BlackScholesInput): BlackScholesOutput {
  const { spot: S, strike: K, timeYears: T, iv: sigma } = input;
  const r = input.riskFreeRate ?? RISK_FREE_RATE;

  // Edge case : à l'expiration ou très près
  if (T <= 0 || sigma <= 0) {
    const callIntrinsic = Math.max(S - K, 0);
    const putIntrinsic = Math.max(K - S, 0);
    return {
      callPrice: callIntrinsic,
      putPrice: putIntrinsic,
      callDelta: S > K ? 1 : 0,
      putDelta: S < K ? -1 : 0,
      callTheta: 0,
      putTheta: 0,
    };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1 = normalCdf(d1);
  const Nd2 = normalCdf(d2);
  const NminusD1 = normalCdf(-d1);
  const NminusD2 = normalCdf(-d2);

  const callPrice = S * Nd1 - K * Math.exp(-r * T) * Nd2;
  const putPrice = K * Math.exp(-r * T) * NminusD2 - S * NminusD1;

  // Theta annualisé puis ramené par-jour (/365)
  const phid1 = normalPdf(d1);
  const callThetaAnnual = -(S * phid1 * sigma) / (2 * sqrtT) - r * K * Math.exp(-r * T) * Nd2;
  const putThetaAnnual = -(S * phid1 * sigma) / (2 * sqrtT) + r * K * Math.exp(-r * T) * NminusD2;

  return {
    callPrice,
    putPrice,
    callDelta: Nd1,
    putDelta: Nd1 - 1,
    callTheta: callThetaAnnual / 365,
    putTheta: putThetaAnnual / 365,
  };
}

/**
 * Helper pour mark-to-market d'une position option.
 */
export interface MarkOptionInput {
  spot: number;
  strike: number;
  expiryDate: string; // YYYY-MM-DD
  asOfDate: string;   // YYYY-MM-DD
  iv: number;
  kind: 'call' | 'put';
  contracts: number;
  premiumPaid: number;
}

export function markOption(input: MarkOptionInput): {
  pricePerUnit: number;
  totalValueUsd: number;
  pnlUsd: number;
  delta: number;
  thetaPerDay: number;
} {
  const daysToExpiry = Math.max(
    0,
    (new Date(input.expiryDate).getTime() - new Date(input.asOfDate).getTime()) / (1000 * 60 * 60 * 24),
  );
  const T = daysToExpiry / 365;

  const bs = blackScholes({
    spot: input.spot,
    strike: input.strike,
    timeYears: T,
    iv: input.iv,
  });

  const pricePerUnit = input.kind === 'call' ? bs.callPrice : bs.putPrice;
  const totalValueUsd = pricePerUnit * input.contracts * 100;
  const pnlUsd = totalValueUsd - input.premiumPaid;
  const delta = input.kind === 'call' ? bs.callDelta : bs.putDelta;
  const thetaPerDay =
    (input.kind === 'call' ? bs.callTheta : bs.putTheta) * input.contracts * 100;

  return { pricePerUnit, totalValueUsd, pnlUsd, delta, thetaPerDay };
}
