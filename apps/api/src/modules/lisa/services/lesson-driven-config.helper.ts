/**
 * lesson-driven-config.helper — wiring des colonnes lisa_session_configs
 * ajoutées par migration 0172 (lesson auto-apply targets).
 *
 * Contexte 27/05/2026 — `LessonAutoApplyService` écrit des UPDATE sur des
 * colonnes telles que `gainers_early_exit_drawdown_threshold_pct`,
 * `gainers_choppy_min_monotonicity`, `gainers_trailing_stop_breakeven_min_drawdown_pct`,
 * `gainers_hour_blacklist_*_UTC`, etc. La migration 0172 a créé ces colonnes
 * pour que les UPDATE ne fail plus silencieusement, mais aucun code path ne
 * les LISAIT au runtime. Ce helper centralise la lecture + le parsing.
 *
 * Convention : si la colonne est null/undefined OU hors range → return null,
 * et le caller fallback au comportement actuel (env var / default hardcoded).
 * Aucune régression de comportement back-compat.
 */
export interface LessonTargetsRow {
  // Early-exit guard (FADE Gemini calibration)
  gainers_early_exit_drawdown_threshold_pct?: number | string | null;
  gainers_early_exit_min_age_seconds?: number | null;
  // Trailing stop breakeven activation
  gainers_trailing_stop_breakeven_min_drawdown_pct?: number | string | null;
  // Choppy exit
  gainers_choppy_exit_after_min?: number | null;
  gainers_choppy_min_monotonicity?: number | string | null;
  // Per-portfolio hour blacklists (TEXT CSV)
  gainers_hour_blacklist_ASIA_UTC?: string | null;
  gainers_hour_blacklist_EU_UTC?: string | null;
  gainers_hour_blacklist_US_UTC?: string | null;
}

/**
 * Parse un NUMERIC clamp dans une plage. Retourne null si valeur invalide
 * (null / NaN / hors bornes) → caller fallback.
 */
export function parseClampedNumber(
  raw: number | string | null | undefined,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/**
 * Parse un INT clamp. Retourne null si invalide.
 */
export function parseClampedInt(
  raw: number | null | undefined,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw === undefined) return null;
  if (!Number.isInteger(raw) && !Number.isFinite(raw)) return null;
  const n = Math.floor(Number(raw));
  if (n < min || n > max) return null;
  return n;
}

/**
 * Parse une chaîne CSV d'heures UTC `0,1,5,23` → Set<number>.
 * Filtre tokens vides + hors [0,23].
 */
export function parseHoursCsvSet(csv: string | null | undefined): Set<number> {
  if (!csv || typeof csv !== 'string' || csv.trim().length === 0) return new Set();
  const out = new Set<number>();
  for (const tok of csv.split(',')) {
    const t = tok.trim();
    if (t.length === 0) continue;
    const n = Number.parseInt(t, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 23) out.add(n);
  }
  return out;
}

/**
 * Vue typée des seuils early-exit issus de la config DB.
 * - drawdownThresholdPct : magnitude (positive) du seuil de perte unrealized
 *   au-delà duquel on autorise la FADE close. Default code = 0 (pas de gate).
 * - minAgeSeconds : âge minimum d'une position avant qu'elle puisse être
 *   FADE-closed. Empêche les exits trop précoces sur U-shape recovery.
 */
export interface EarlyExitThresholds {
  drawdownThresholdPct: number | null;
  minAgeSeconds: number | null;
}

export function extractEarlyExitThresholds(row: LessonTargetsRow): EarlyExitThresholds {
  return {
    drawdownThresholdPct: parseClampedNumber(
      row.gainers_early_exit_drawdown_threshold_pct,
      0,
      10,
    ),
    minAgeSeconds: parseClampedInt(row.gainers_early_exit_min_age_seconds ?? null, 0, 3600),
  };
}

/**
 * Choppy-exit thresholds. Default activé via migration (10min / 0.55 monotonicity).
 * Désactivable par lesson en mettant gainers_choppy_exit_after_min à null
 * (mais ALTER ne le permet pas tel quel — caller passe null = pas appliqué).
 */
export interface ChoppyExitThresholds {
  afterMinutes: number | null;
  minMonotonicity: number | null;
}

export function extractChoppyExitThresholds(row: LessonTargetsRow): ChoppyExitThresholds {
  // Migration 0172 — afterMinutes peut être 0 (= désactive le gate côté caller :
  // n'importe quel age >= 0 ⇒ check immédiat, ce qui n'est pas désiré).
  // On considère 0 = OFF (return null), comportement attendu côté lesson :
  // "réactiver le defaut hardcoded" se fait en remettant la colonne à null.
  const after = parseClampedInt(row.gainers_choppy_exit_after_min ?? null, 1, 120);
  return {
    afterMinutes: after,
    minMonotonicity: parseClampedNumber(row.gainers_choppy_min_monotonicity, 0, 1),
  };
}

/**
 * Trailing-stop breakeven activation depuis la config DB (en %, ex 0.5 = 0.5%).
 * Le caller convertit en ratio (×100) avant de le passer à `computeBreakEvenStopUpdate`.
 */
export function extractBreakevenActivationPct(row: LessonTargetsRow): number | null {
  return parseClampedNumber(row.gainers_trailing_stop_breakeven_min_drawdown_pct, 0, 5);
}

/**
 * Per-portfolio hour blacklist override pour une classe d'actif. Merge avec
 * la blacklist globale (env Fly) en UNION : ce qui est blacklisté dans l'un
 * OU l'autre est skip. Ne réduit jamais le filtre global (safety wins).
 */
export function mergeHourBlacklist(
  globalSet: Set<number>,
  perPortfolioCsv: string | null | undefined,
): Set<number> {
  const dbSet = parseHoursCsvSet(perPortfolioCsv);
  if (dbSet.size === 0) return globalSet;
  if (globalSet.size === 0) return dbSet;
  return new Set([...globalSet, ...dbSet]);
}

/**
 * Calcule un proxy simple de "monotonicity" d'une position basé sur
 * la rétention de la MFE (Max Favorable Excursion).
 *
 * Sans candle fetch ni recompute coûteux : on regarde simplement quelle
 * proportion du pic favorable la position retient au moment de l'évaluation.
 *
 *   monotonicity = currentPnlPct / peakPnlPct  ∈ [-∞, 1]
 *
 * - 1.0  → position est au pic (pas de giveback)
 * - 0.5  → position a redonné la moitié du gain
 * - 0    → position a redonné tout le gain (breakeven)
 * - < 0  → position est désormais en perte malgré un pic positif (très choppy)
 *
 * On ne calcule pas si peakPnlPct ≤ minPeakPct (positions pas encore montées
 * → pas pertinent comme proxy choppy, c'est juste un trade plat).
 *
 * Returns null si pas calculable (pas de peak, pas de gain initial).
 */
export function computeMonotonicityProxy(args: {
  entryPrice: number;
  currentPrice: number;
  peakPrice: number | null;
  isLong: boolean;
  /** Seuil min du pic favorable pour que le ratio soit pertinent (default 0.2%). */
  minPeakPct?: number;
}): number | null {
  const { entryPrice, currentPrice, peakPrice, isLong } = args;
  const minPeakPct = args.minPeakPct ?? 0.2;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  if (peakPrice === null || !Number.isFinite(peakPrice) || peakPrice <= 0) return null;

  const peakPnlPct = isLong
    ? ((peakPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - peakPrice) / entryPrice) * 100;
  const currentPnlPct = isLong
    ? ((currentPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - currentPrice) / entryPrice) * 100;

  if (peakPnlPct < minPeakPct) return null;
  return currentPnlPct / peakPnlPct;
}
