/**
 * Per-class "anti chase-the-top" threshold override — pure helper, no I/O.
 *
 * Analyse data 25/05 (434 trades fermés joinés sur change_pct@entry) :
 *
 *   asia_equity (n=183) :
 *     [10-15%]  WR 44 % mean +0.50 % sum +$234  ← GAGNANT
 *     [15-20%]  WR 53 % mean +0.68 % sum +$181  ← GAGNANT
 *     [20-30%]  WR 72 % mean +0.10 % sum  -$71  ← WR excellent
 *   → seuil actuel 10 % détruit l'edge ASIA. Optimum = 30 % (ou disabled).
 *
 *   eu_equity (n=99) :
 *     [10-15%]  WR 57 % mean +0.32 % → GAGNANT, seuil 15 % raisonnable
 *
 *   us_equity_large (n=60) :
 *     [10-15%]  WR 63 % mean +0.40 % → GAGNANT, seuil 15 % raisonnable
 *
 *   us_equity_small_mid (n=77) :
 *     [7.5-10%] WR 73 % mean +1.20 % → sweet spot
 *     [10-15%]  WR 41 % mean -0.21 % → dégrade
 *   → seuil 10 % confirmé optimal pour US small/mid.
 *
 *   crypto (n=15) : sample insuffisant → garde seuil global.
 *
 * Default OFF (= retombe sur GAINERS_MAX_CHANGE_PCT_LONG global, comportement actuel).
 * Quand activée, chaque classe a son seuil propre via env var dédiée.
 */

export interface MaxChangePerClassConfig {
  asia: number | null;            // null = use fallback
  eu: number | null;
  us_large: number | null;
  us_small_mid: number | null;
  crypto: number | null;
}

/**
 * Défauts per-class SENSÉS (03/06/2026) — alignés sur overpump-per-class.helper
 * + validés par backtest band-by-band (scripts/backtest-overextended-by-band.ts).
 *
 * Rationale : avant, tous null → les classes sans secret Fly tombaient sur le
 * fallback global `GAINERS_MAX_CHANGE_PCT_LONG`, qui écrasait silencieusement
 * leur calibration. Bug constaté 03/06 : asia capé à ~12 (global) alors que la
 * data montre asia 15-30 % profitable (+0.5 à +0.9 %/trade) → edge détruit.
 *
 * Backtest 03/06 (TP+3/SL-1.5, 60min) :
 *   - us_small_mid : 10-15 % breakeven, 15-25 % perdant → cap 10 ✓
 *   - asia         : 15-25 % +0.54 %, 25-100 % +0.93 % → cap 30 (large band)
 *   - eu           : cap 15 (calibration existante)
 *   - us_large     : cap 15 (large caps moins volatiles)
 *   - crypto       : cap 30 (volatilité native ; à affiner via backtest Binance)
 *
 * Un secret Fly per-class `GAINERS_MAX_CHANGE_PCT_LONG_<CLASS>` prime toujours
 * sur ces défauts (cf. parse() ci-dessous).
 */
// 04/06/2026 — VANNES OUVERTES (user). Caps relâchés pour laisser passer les
// runners (FR.PA +18%, DEBS.LSE +17%, BME.LSE +14.6% étaient jetés à 15). Le
// user assume le chase, protégé par SL mécanique + contrôle manuel par position.
// Réversible. (Avant : eu 15, us_large 15, us_small_mid 10.)
export const DEFAULT_MAX_CHANGE_PER_CLASS: MaxChangePerClassConfig = {
  asia: 30, eu: 30, us_large: 30, us_small_mid: 25, crypto: 30,
};

export function parseMaxChangePerClassConfig(env: {
  GAINERS_MAX_CHANGE_PCT_LONG_ASIA?: string | undefined;
  GAINERS_MAX_CHANGE_PCT_LONG_EU?: string | undefined;
  GAINERS_MAX_CHANGE_PCT_LONG_US_LARGE?: string | undefined;
  GAINERS_MAX_CHANGE_PCT_LONG_US_SMALL_MID?: string | undefined;
  GAINERS_MAX_CHANGE_PCT_LONG_CRYPTO?: string | undefined;
}): MaxChangePerClassConfig {
  // parse(raw, def) : secret Fly prime ; sinon défaut sensé per-class (≠ null
  // → la classe n'hérite JAMAIS du global, fix anti-écrasement 03/06).
  // 04/06/2026 — Le défaut code est un PLANCHER de permissivité. Un secret Fly
  // ne peut que RELÂCHER (cap plus haut), JAMAIS resserrer sous le défaut. Ainsi
  // les vannes restent ouvertes sans toucher Fly, même si un vieux secret =15 traîne.
  const parse = (raw: string | undefined, def: number): number => {
    if (raw == null || raw.trim() === '') return def;
    const n = Number.parseFloat(raw);
    const v = Number.isFinite(n) && n > 0 && n <= 100 ? n : def;
    return Math.max(v, def);
  };
  return {
    asia: parse(env.GAINERS_MAX_CHANGE_PCT_LONG_ASIA, DEFAULT_MAX_CHANGE_PER_CLASS.asia!),
    eu: parse(env.GAINERS_MAX_CHANGE_PCT_LONG_EU, DEFAULT_MAX_CHANGE_PER_CLASS.eu!),
    us_large: parse(env.GAINERS_MAX_CHANGE_PCT_LONG_US_LARGE, DEFAULT_MAX_CHANGE_PER_CLASS.us_large!),
    us_small_mid: parse(env.GAINERS_MAX_CHANGE_PCT_LONG_US_SMALL_MID, DEFAULT_MAX_CHANGE_PER_CLASS.us_small_mid!),
    crypto: parse(env.GAINERS_MAX_CHANGE_PCT_LONG_CRYPTO, DEFAULT_MAX_CHANGE_PER_CLASS.crypto!),
  };
}

/**
 * Résout le seuil effectif pour une asset_class donnée.
 *   1. Si override per-class défini (non-null) → utilise lui
 *   2. Sinon → fallback global
 *
 * Retourne 0 si fallback = 0 (= filtre OFF), comportement actuel inchangé.
 */
export function resolveMaxChangePct(
  assetClass: string | null | undefined,
  cfg: MaxChangePerClassConfig,
  fallbackGlobal: number,
): number {
  if (typeof assetClass === 'string') {
    if (assetClass === 'asia_equity' && cfg.asia != null) return cfg.asia;
    if (assetClass === 'eu_equity' && cfg.eu != null) return cfg.eu;
    if (assetClass === 'us_equity_large' && cfg.us_large != null) return cfg.us_large;
    if (assetClass === 'us_equity_small_mid' && cfg.us_small_mid != null) return cfg.us_small_mid;
    if (assetClass.startsWith('crypto') && cfg.crypto != null) return cfg.crypto;
  }
  return fallbackGlobal;
}

/**
 * Helper d'affichage pour le boot log.
 */
export function describeOverrides(cfg: MaxChangePerClassConfig): string | null {
  const parts: string[] = [];
  if (cfg.asia != null) parts.push(`asia=${cfg.asia}`);
  if (cfg.eu != null) parts.push(`eu=${cfg.eu}`);
  if (cfg.us_large != null) parts.push(`us_large=${cfg.us_large}`);
  if (cfg.us_small_mid != null) parts.push(`us_small_mid=${cfg.us_small_mid}`);
  if (cfg.crypto != null) parts.push(`crypto=${cfg.crypto}`);
  return parts.length > 0 ? parts.join(' ') : null;
}
