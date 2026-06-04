/**
 * Per-class OVERPUMP_THRESHOLD override — pure helper, no I/O.
 *
 * Bug observé 03/06/2026 (mercredi matin Asia open) :
 * - GAINERS_MAX_CHANGE_PCT_LONG_ASIA=30 set par utilisateur (cohérent ADDENDUM A3)
 * - MAIS GAINERS_OVERPUMP_THRESHOLD_PCT=12 (default global) catch tout > 12%
 * - Résultat : 292/344 rejets reject_overextended étaient des 12-30% movers Asia
 *   (082800.KQ +29.82% rejeté 36×, 300197.SHE +20.21% rejeté 60×, etc.)
 *
 * Cause racine : le gate OVERPUMP global ignorait la calibration per-class.
 * Fix : seuil per-class avec defaults SENSÉS issus de l'analyse 25/05/2026
 * (cf. max-change-per-class.helper.ts pour les WR par bucket) — pas null
 * comme MAX_CHANGE_PCT_LONG, parce qu'on veut le fix actif IMMÉDIATEMENT
 * sans demander à l'utilisateur de set 4+ Fly secrets.
 *
 *   asia       : 30 (cohérent avec MAX_CHANGE_ASIA, ADDENDUM A3 "10-30%")
 *   eu         : 15 (mean reversion au-delà)
 *   us_large   : 15 (mean reversion au-delà)
 *   us_small_mid : 15 (cf. analyse 25/05 [10-15] WR 41 % mean -0.21%)
 *   crypto     : 30 (volatilité native crypto, threshold strict inutile)
 *
 * Override via env GAINERS_OVERPUMP_THRESHOLD_PCT_<CLASS> si besoin.
 * Fallback ultime sur GAINERS_OVERPUMP_THRESHOLD_PCT global (legacy).
 */

export interface OverpumpPerClassConfig {
  asia: number;
  eu: number;
  us_large: number;
  us_small_mid: number;
  crypto: number;
}

// 04/06/2026 — VANNES OUVERTES (user) : overpump gate #2 relâché en cohérence
// avec max-change (eu/us_large 15→30, us_small_mid 15→25). Sinon ce 2e cap
// rebloquait les runners. SL + contrôle manuel = filets. Réversible.
export const DEFAULT_OVERPUMP_PER_CLASS: OverpumpPerClassConfig = {
  asia: 30,
  eu: 30,
  us_large: 30,
  us_small_mid: 25,
  crypto: 30,
};

export function parseOverpumpPerClassConfig(env: {
  GAINERS_OVERPUMP_THRESHOLD_PCT_ASIA?: string | undefined;
  GAINERS_OVERPUMP_THRESHOLD_PCT_EU?: string | undefined;
  GAINERS_OVERPUMP_THRESHOLD_PCT_US_LARGE?: string | undefined;
  GAINERS_OVERPUMP_THRESHOLD_PCT_US_SMALL_MID?: string | undefined;
  GAINERS_OVERPUMP_THRESHOLD_PCT_CRYPTO?: string | undefined;
}): OverpumpPerClassConfig {
  const parse = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw.trim() === '') return fallback;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
  };
  return {
    asia: parse(env.GAINERS_OVERPUMP_THRESHOLD_PCT_ASIA, DEFAULT_OVERPUMP_PER_CLASS.asia),
    eu: parse(env.GAINERS_OVERPUMP_THRESHOLD_PCT_EU, DEFAULT_OVERPUMP_PER_CLASS.eu),
    us_large: parse(env.GAINERS_OVERPUMP_THRESHOLD_PCT_US_LARGE, DEFAULT_OVERPUMP_PER_CLASS.us_large),
    us_small_mid: parse(env.GAINERS_OVERPUMP_THRESHOLD_PCT_US_SMALL_MID, DEFAULT_OVERPUMP_PER_CLASS.us_small_mid),
    crypto: parse(env.GAINERS_OVERPUMP_THRESHOLD_PCT_CRYPTO, DEFAULT_OVERPUMP_PER_CLASS.crypto),
  };
}

/**
 * Résout le seuil overpump effectif pour une asset_class.
 *
 * Priorité :
 *   1. Per-class config (toujours défini grâce aux defaults sensés)
 *   2. Si globalOverride > 0 ET globalOverride < per-class → utilise globalOverride
 *      (legacy : un opérateur peut encore restreindre globalement)
 *
 * Note : on prend min(per-class, global) si global est défini, pour garantir
 * que le legacy `GAINERS_OVERPUMP_THRESHOLD_PCT` reste un "kill switch" descendant.
 * Pour relâcher, on bump le per-class. Pour resserrer urgemment, on bump le global.
 */
export function resolveOverpumpThreshold(
  assetClass: string | null | undefined,
  cfg: OverpumpPerClassConfig,
  globalOverride: number,
): number {
  let perClass = cfg.asia;
  if (typeof assetClass === 'string') {
    if (assetClass === 'asia_equity') perClass = cfg.asia;
    else if (assetClass === 'eu_equity') perClass = cfg.eu;
    else if (assetClass === 'us_equity_large') perClass = cfg.us_large;
    else if (assetClass === 'us_equity_small_mid') perClass = cfg.us_small_mid;
    else if (assetClass.startsWith('crypto')) perClass = cfg.crypto;
    else perClass = cfg.us_large; // unknown class → conservative 15
  }
  if (globalOverride > 0 && globalOverride < perClass) return globalOverride;
  return perClass;
}

export function describeOverpumpOverrides(cfg: OverpumpPerClassConfig): string {
  return `asia=${cfg.asia} eu=${cfg.eu} us_large=${cfg.us_large} us_small_mid=${cfg.us_small_mid} crypto=${cfg.crypto}`;
}
