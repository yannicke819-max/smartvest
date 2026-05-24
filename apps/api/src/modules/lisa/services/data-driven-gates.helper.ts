/**
 * Data-driven gates per-class — issus de l'audit 23-24/05 sur 479 trades fermés.
 *
 * Constat critique 2e half (15-22 mai) : -$3,048 sum dont **asia_equity entre
 * H00-02 UTC = -$1,300 sur 91 trades, WR 26%**. Pattern stable et concentré.
 *
 * Gate horaire par asset_class permet de couper l'exposition aux heures
 * structurellement perdantes SANS toucher aux heures profitables de la même
 * classe.
 *
 * Bonus : ticker whitelist size multiplier pour les rares tickers avec
 * WR > 60% confirmé sur n >= 8.
 *
 * Default : tous OFF. Activation par env Fly individuelle, A/B testable.
 *
 * Pas de friction avec :
 *   - GAINERS_LONG_HOUR_BLACKLIST_UTC (gate global existant — reste actif)
 *   - GAINERS_LONG_HOUR_WHITELIST_UTC (gate global existant — reste actif)
 *   - STAGFLATION_HEDGE_GUARD_ENABLED
 *   - Tous autres flags scanner
 *
 * Le gate par-classe s'applique en SUPPLÉMENT du gate global (OR logique).
 */

export interface PerClassHourBlacklistConfig {
  asia_equity: Set<number>;
  us_equity_large: Set<number>;
  us_equity_small_mid: Set<number>;
  eu_equity: Set<number>;
  crypto_major: Set<number>;
  crypto_alt: Set<number>;
}

export interface TickerSizeMultConfig {
  /** Map symbol UPPERCASE → multiplier (e.g. 1.5 = +50% size). */
  multipliers: Map<string, number>;
}

const HOUR_REGEX = /^\d{1,2}$/;

/**
 * Parse une chaîne CSV d'heures UTC en Set<number>. Pure, testable.
 * Filtre :
 *   - chaînes vides → Set vide
 *   - heures hors [0,23] → ignorées
 *   - duplicates → dédupliqués naturellement par Set
 */
export function parseHoursCsv(csv: string | undefined): Set<number> {
  if (!csv || csv.trim().length === 0) return new Set();
  const out = new Set<number>();
  for (const token of csv.split(',')) {
    const t = token.trim();
    if (!HOUR_REGEX.test(t)) continue;
    const n = Number.parseInt(t, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 23) out.add(n);
  }
  return out;
}

/**
 * Parse la config full per-class depuis env vars. Pure, testable.
 */
export function parsePerClassHourBlacklist(env: {
  GAINERS_HOUR_BLACKLIST_ASIA_UTC?: string | undefined;
  GAINERS_HOUR_BLACKLIST_US_UTC?: string | undefined;
  GAINERS_HOUR_BLACKLIST_EU_UTC?: string | undefined;
  GAINERS_HOUR_BLACKLIST_CRYPTO_UTC?: string | undefined;
}): PerClassHourBlacklistConfig {
  const asia = parseHoursCsv(env.GAINERS_HOUR_BLACKLIST_ASIA_UTC);
  const us = parseHoursCsv(env.GAINERS_HOUR_BLACKLIST_US_UTC);
  const eu = parseHoursCsv(env.GAINERS_HOUR_BLACKLIST_EU_UTC);
  const crypto = parseHoursCsv(env.GAINERS_HOUR_BLACKLIST_CRYPTO_UTC);
  return {
    asia_equity: asia,
    us_equity_large: us,
    us_equity_small_mid: us,
    eu_equity: eu,
    crypto_major: crypto,
    crypto_alt: crypto,
  };
}

/**
 * Returns true si le candidat doit être skip par le gate horaire par-classe.
 * @returns true → skip. false → passe.
 */
export function shouldSkipByPerClassHourGate(
  assetClass: string,
  hourUtc: number,
  config: PerClassHourBlacklistConfig,
): boolean {
  const cls = assetClass as keyof PerClassHourBlacklistConfig;
  const blacklist = config[cls];
  if (!blacklist || blacklist.size === 0) return false;
  return blacklist.has(hourUtc);
}

/**
 * Parse "TICKER:MULT,TICKER:MULT" → Map<symbol_uppercase, multiplier>.
 * Pure, testable.
 *
 * Garde-fous :
 *   - multiplier < 0.1 ou > 3.0 → ignoré (sécurité anti-rounding bug)
 *   - format invalide → ignoré (silencieusement, log côté caller)
 */
export function parseTickerSizeMultCsv(csv: string | undefined): TickerSizeMultConfig {
  const out = new Map<string, number>();
  if (!csv || csv.trim().length === 0) return { multipliers: out };
  for (const pair of csv.split(',')) {
    const parts = pair.split(':');
    if (parts.length !== 2) continue;
    const sym = parts[0].trim().toUpperCase();
    const mult = Number.parseFloat(parts[1].trim());
    if (!sym || !Number.isFinite(mult)) continue;
    if (mult < 0.1 || mult > 3.0) continue; // safety clamp
    out.set(sym, Math.round(mult * 100) / 100);
  }
  return { multipliers: out };
}

/**
 * Returns le multiplier de size pour ce symbole (default 1.0).
 */
export function getTickerSizeMultiplier(
  symbol: string,
  config: TickerSizeMultConfig,
): number {
  return config.multipliers.get(symbol.toUpperCase()) ?? 1.0;
}
