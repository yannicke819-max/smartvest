/**
 * Per-class pathEff floor override — pure helper (no I/O).
 *
 * Data analyse 30j (scripts/analyze-pathEff-by-class.ts, mai 2026) montre :
 *   - Crypto : zone <0.50 = WR 16-23 %, ratio SL/TP 28:1 → NE PAS relâcher
 *   - US      : bande [0.40-0.50] = WR 79 % (n=89/30j) → relâcher de 0.50 à 0.40
 *   - EU      : bande [0.30-0.40] = WR 42 % (n=31)     → potentiel à monitorer
 *
 * Permet de configurer un floor différent par grande classe d'actif sans
 * toucher au comportement Asia (qui passe par asia_strictness_boost).
 *
 * Env vars (default toutes vides = OFF = back-compat 100 %) :
 *   GAINERS_MIN_PATH_EFFICIENCY_US     ex "0.40"
 *   GAINERS_MIN_PATH_EFFICIENCY_EU     ex "0.40"
 *   GAINERS_MIN_PATH_EFFICIENCY_CRYPTO ex "0.50"
 *
 * Si la var est vide ou hors [0, 1], elle est ignorée → baseFloor s'applique.
 */

export interface PerClassPathEffOverrides {
  us?: number;
  eu?: number;
  crypto?: number;
}

export function parsePerClassPathEffOverrides(env: {
  GAINERS_MIN_PATH_EFFICIENCY_US?: string | undefined;
  GAINERS_MIN_PATH_EFFICIENCY_EU?: string | undefined;
  GAINERS_MIN_PATH_EFFICIENCY_CRYPTO?: string | undefined;
}): PerClassPathEffOverrides {
  const out: PerClassPathEffOverrides = {};
  const us = parseFloor(env.GAINERS_MIN_PATH_EFFICIENCY_US);
  const eu = parseFloor(env.GAINERS_MIN_PATH_EFFICIENCY_EU);
  const crypto = parseFloor(env.GAINERS_MIN_PATH_EFFICIENCY_CRYPTO);
  if (us != null) out.us = us;
  if (eu != null) out.eu = eu;
  if (crypto != null) out.crypto = crypto;
  return out;
}

function parseFloor(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return undefined;
  return n;
}

/**
 * Calcule le floor pathEff effectif pour un candidat donné.
 *
 * Règles (ordre de précédence) :
 *   1. baseFloor null → retourne null (gate désactivé global)
 *   2. assetClass='asia_equity' → baseFloor + asiaStrictnessBoost (préservé, indépendant)
 *   3. assetClass match override per-class → utilise l'override
 *   4. sinon → baseFloor
 *
 * Note : si l'utilisateur set GAINERS_MIN_PATH_EFFICIENCY_US=0.40 alors qu'asia
 * a un boost à +0.10 sur baseFloor=0.50, asia reste à 0.60 (logique Asia
 * indépendante). Le per-class override n'affecte JAMAIS l'asia.
 */
export function resolveEffectivePathEffFloor(
  baseFloor: number | null,
  assetClass: string | null | undefined,
  overrides: PerClassPathEffOverrides,
  asiaStrictnessBoost: number,
): number | null {
  if (baseFloor == null) return null;
  if (assetClass === 'asia_equity') {
    return Math.min(1, baseFloor + asiaStrictnessBoost);
  }
  if (typeof assetClass === 'string') {
    if (assetClass.startsWith('us_') && overrides.us != null) return overrides.us;
    if (assetClass === 'eu_equity' && overrides.eu != null) return overrides.eu;
    if (assetClass.startsWith('crypto') && overrides.crypto != null) return overrides.crypto;
  }
  return baseFloor;
}

/**
 * Helper d'affichage pour le log de boot — retourne string décrivant les overrides actifs,
 * ou null si aucun override (= back-compat silencieux).
 */
export function describeOverrides(overrides: PerClassPathEffOverrides): string | null {
  const parts: string[] = [];
  if (overrides.us != null) parts.push(`us=${overrides.us}`);
  if (overrides.eu != null) parts.push(`eu=${overrides.eu}`);
  if (overrides.crypto != null) parts.push(`crypto=${overrides.crypto}`);
  return parts.length > 0 ? parts.join(' ') : null;
}
