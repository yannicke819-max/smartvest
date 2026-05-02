/**
 * BLOC 4 — Calcul TP / SL initial à l'ouverture d'une position.
 *
 * Spec ADR-005 PR5 (locked) :
 *   Equity : TP = +path_eff × 1.5  ;  SL = -path_eff × 1.0
 *   Crypto : TP = +path_eff × 2.0  ;  SL = -path_eff × 0.8
 *
 * `path_eff` est le path efficiency P9-UX ∈ [0, 1] — interprété comme un
 * pourcentage de mouvement attendu (0.6 → 0.6%).
 *
 * Exemple equity, path_eff = 0.6, entry = $100 :
 *   TP_pct = 0.6 × 1.5 = 0.9 % → tp_price = 100 × 1.009 = $100.90
 *   SL_pct = 0.6 × 1.0 = 0.6 % → sl_price = 100 × 0.994 = $99.40
 */

export interface TpSlConfig {
  equityTpMultiplier: number;
  equitySlMultiplier: number;
  cryptoTpMultiplier: number;
  cryptoSlMultiplier: number;
}

export const DEFAULT_TP_SL_CONFIG: TpSlConfig = {
  equityTpMultiplier: 1.5,
  equitySlMultiplier: 1.0,
  cryptoTpMultiplier: 2.0,
  cryptoSlMultiplier: 0.8,
};

export interface TpSlInput {
  entryPrice: number;
  pathEff: number;
  marketClass: 'equity' | 'crypto';
}

export interface TpSlResult {
  tpPrice: number;
  slPrice: number;
  /** TP fraction décimale (ex: 0.009 = 0.9%). */
  tpPct: number;
  /** SL fraction décimale (positive : 0.006 = 0.6% drawdown). */
  slPct: number;
}

export function computeInitialTpSl(
  input: TpSlInput,
  cfg: TpSlConfig = DEFAULT_TP_SL_CONFIG,
): TpSlResult {
  const { entryPrice, pathEff, marketClass } = input;

  const tpMul = marketClass === 'crypto' ? cfg.cryptoTpMultiplier : cfg.equityTpMultiplier;
  const slMul = marketClass === 'crypto' ? cfg.cryptoSlMultiplier : cfg.equitySlMultiplier;

  // path_eff in [0, 1] interprété comme % → fraction décimale
  const tpPct = pathEff * tpMul / 100;
  const slPct = pathEff * slMul / 100;

  return {
    tpPrice: entryPrice * (1 + tpPct),
    slPrice: entryPrice * (1 - slPct),
    tpPct,
    slPct,
  };
}
