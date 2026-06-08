/**
 * Sizing dynamique oversold — calcule le notionnel de CHAQUE position à l'ouverture,
 * automatiquement, à partir de l'edge prouvé (bande de drop) + le régime (VIX),
 * borné par un plancher et un plafond. Tout est CONFIGURABLE (env), avec des
 * défauts sains → automatique dès l'install, sans rien régler.
 *
 * Logique (demande user 08/06/2026) :
 *   notional = base × multiplicateur(bande) × amortisseur(VIX), clampé [plancher, plafond]
 *
 *   - base : soit un % du capital (basePctCapital, prioritaire → auto-scale avec
 *     le capital, recommandé) soit un notionnel fixe en $ (baseNotionalUsd,
 *     back-compat). Le % évite de re-régler le ticket à chaque changement de
 *     capital et garde un risque cohérent entre portefeuilles (US $150k / EU $20k).
 *   - bande -8/-12% (alpha J+10 +2,45%, meilleur edge) → ×2,0 par défaut
 *   - bande -5/-8%  (alpha +1%)                         → ×1,0
 *   - VIX ≥30 (stress) → ×0,5 · VIX 20-30 (élevé) → ×0,8 · <20 → ×1,0
 *   - plancher : OVERSOLD_SIZE_FLOOR_USD (default $500) — jamais de ticket ridicule
 *   - plafond  : OVERSOLD_SIZE_CEILING_PCT_CAPITAL % du capital (default 12%) — anti-concentration
 *
 * Désactivable via OVERSOLD_DYNAMIC_SIZING_ENABLED=false → retombe sur le notionnel flat.
 */

export interface OversoldSizingResult {
  notionalUsd: number;
  band: string;
  bandMult: number;
  vixDamp: number;
  clamp: 'floor' | 'ceiling' | null;
  dynamic: boolean;
}

/** Paramètres réglables (depuis l'UI/DB). Chaque champ optionnel tombe sur env puis défaut. */
export interface OversoldSizingConfig {
  enabled?: boolean | null;
  /** Base = capital × ce % (prioritaire sur baseNotionalUsd, auto-scale). null = base fixe. */
  basePctCapital?: number | null;
  bandMultDeep?: number | null;
  bandMultShallow?: number | null;
  vixDampElevated?: number | null;
  vixDampStress?: number | null;
  floorUsd?: number | null;
  ceilingPctCapital?: number | null;
}

function envNum(key: string, def: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : def;
}

/** Résout un numérique : valeur DB si fournie, sinon env, sinon défaut code. */
function resolveNum(dbVal: number | null | undefined, envKey: string, def: number): number {
  if (dbVal != null && Number.isFinite(Number(dbVal))) return Number(dbVal);
  return envNum(envKey, def);
}

export function computeOversoldNotional(p: {
  baseNotionalUsd: number;
  dropPct: number | null;
  vix: number | null;
  capitalUsd: number;
  config?: OversoldSizingConfig;
}): OversoldSizingResult {
  const c = p.config ?? {};
  const enabled = c.enabled != null
    ? c.enabled === true
    : (process.env.OVERSOLD_DYNAMIC_SIZING_ENABLED ?? 'true').toLowerCase() === 'true';
  // Base = % du capital si configuré (auto-scale, prioritaire), sinon notionnel
  // fixe (back-compat). OVERSOLD_SIZE_BASE_PCT_CAPITAL en fallback env.
  const basePct = resolveNum(c.basePctCapital, 'OVERSOLD_SIZE_BASE_PCT_CAPITAL', 0);
  const base = basePct > 0 && p.capitalUsd > 0
    ? Math.max(0, (p.capitalUsd * basePct) / 100)
    : Math.max(0, p.baseNotionalUsd);
  if (!enabled || p.dropPct == null || !Number.isFinite(p.dropPct)) {
    return { notionalUsd: Math.round(base), band: 'flat', bandMult: 1, vixDamp: 1, clamp: null, dynamic: false };
  }

  // Multiplicateur de bande — proportionnel à l'edge (loi empirique oversold).
  const deepMult = resolveNum(c.bandMultDeep, 'OVERSOLD_SIZE_BAND_MULT_DEEP', 2.0); // -8/-12%
  const shallowMult = resolveNum(c.bandMultShallow, 'OVERSOLD_SIZE_BAND_MULT_SHALLOW', 1.0); // -5/-8%
  const band = p.dropPct <= -8 ? '-8/-12%' : '-5/-8%';
  const bandMult = p.dropPct <= -8 ? deepMult : shallowMult;

  // Amortisseur VIX — risk-off → réduire (rebond plus incertain en absolu).
  let vixDamp = 1;
  if (p.vix != null && Number.isFinite(p.vix)) {
    if (p.vix >= 30) vixDamp = resolveNum(c.vixDampStress, 'OVERSOLD_SIZE_VIX_DAMP_STRESS', 0.5);
    else if (p.vix >= 20) vixDamp = resolveNum(c.vixDampElevated, 'OVERSOLD_SIZE_VIX_DAMP_ELEVATED', 0.8);
  }

  let notional = base * bandMult * vixDamp;

  // Caps : plancher absolu + plafond en % du capital (anti-concentration).
  const floor = resolveNum(c.floorUsd, 'OVERSOLD_SIZE_FLOOR_USD', 500);
  const ceilingPct = resolveNum(c.ceilingPctCapital, 'OVERSOLD_SIZE_CEILING_PCT_CAPITAL', 12);
  const ceiling = p.capitalUsd > 0 ? (p.capitalUsd * ceilingPct) / 100 : Number.POSITIVE_INFINITY;
  let clamp: 'floor' | 'ceiling' | null = null;
  if (notional > ceiling) { notional = ceiling; clamp = 'ceiling'; }
  if (notional < floor) { notional = floor; clamp = 'floor'; }

  return { notionalUsd: Math.round(notional), band, bandMult, vixDamp, clamp, dynamic: true };
}
