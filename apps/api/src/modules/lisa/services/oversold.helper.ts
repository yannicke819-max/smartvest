/**
 * Helpers PURS du mode OVERSOLD — extraits pour testabilité sans mock.
 *
 * Couvre :
 *   - le filtre / tri / sélection des candidats du scanner (drop band + liquidité)
 *   - le calcul de jours ouvrés (businessDaysSince) pour l'exit J+10
 *
 * Aucune dépendance NestJS / Supabase / réseau ici : 100% déterministe.
 */

/** Barre EOD minimale (close + volume) issue d'EODHD. */
export interface EodBar {
  date: string; // YYYY-MM-DD
  close: number;
  volume: number;
}

/** Config résolue du mode oversold (defaults appliqués en amont). */
export interface OversoldConfig {
  dropMinPct: number; // borne basse (ex -12) — falling-knife exclu en dessous
  dropMaxPct: number; // borne haute (ex -5)
  holdDays: number;
  stopCatastrophePct: number; // ex -15
  tpPct: number | null; // null = pas de TP
  positionNotionalUsd: number;
  maxOpenPositions: number;
  universe: string;
}

/** Candidat oversold retenu (post-filtre). */
export interface OversoldCandidate {
  symbol: string;
  closeJ: number; // dernier close
  closeJPrev: number; // avant-dernier close
  dropPct: number; // (closeJ/closeJPrev - 1) * 100, négatif
  dollarVolume: number; // closeJ * volumeJ
}

// Seuils de liquidité (spec §3.3) — durs, non configurables en v1.
const MIN_PRICE_USD = 5;
const MIN_DOLLAR_VOLUME_USD = 5_000_000;

/**
 * Calcule le dropPct 1J d'une série de barres EOD.
 * Prend close[J] (dernier) et close[J-1] (avant-dernier).
 * Retourne null si moins de 2 barres exploitables.
 */
export function computeDropPct(bars: EodBar[]): { closeJ: number; closeJPrev: number; dropPct: number } | null {
  if (!bars || bars.length < 2) return null;
  const closeJ = bars[bars.length - 1].close;
  const closeJPrev = bars[bars.length - 2].close;
  if (!Number.isFinite(closeJ) || !Number.isFinite(closeJPrev) || closeJPrev <= 0) return null;
  const dropPct = (closeJ / closeJPrev - 1) * 100;
  return { closeJ, closeJPrev, dropPct };
}

/**
 * Teste si un dropPct est DANS la bande oversold valide.
 *
 * Spec : -12% <= dropPct <= -5% (les deux bornes incluses).
 *   - dropPct < dropMinPct (ex < -12)  → falling-knife, EXCLU
 *   - dropPct > dropMaxPct (ex > -5)   → pas assez de sur-réaction, IGNORÉ
 */
export function isInDropBand(dropPct: number, cfg: OversoldConfig): boolean {
  if (!Number.isFinite(dropPct)) return false;
  return dropPct >= cfg.dropMinPct && dropPct <= cfg.dropMaxPct;
}

/** Teste les seuils de liquidité (prix + dollar-volume). */
export function passesLiquidity(closeJ: number, volumeJ: number): boolean {
  if (!Number.isFinite(closeJ) || closeJ <= MIN_PRICE_USD) return false;
  const dollarVol = closeJ * (Number.isFinite(volumeJ) ? volumeJ : 0);
  return dollarVol > MIN_DOLLAR_VOLUME_USD;
}

/**
 * Construit la liste TRIÉE des candidats oversold à partir des barres EOD.
 *
 * Filtre : drop band + liquidité (prix > $5, dollar-volume > $5M).
 * Tri : par dropPct CROISSANT (le plus négatif = drop le plus fort = meilleur
 * alpha selon le gradient confirmé 3-fold).
 */
export function buildOversoldCandidates(
  barsBySymbol: Map<string, EodBar[]>,
  cfg: OversoldConfig,
): OversoldCandidate[] {
  const out: OversoldCandidate[] = [];
  for (const [symbol, bars] of barsBySymbol.entries()) {
    const drop = computeDropPct(bars);
    if (!drop) continue;
    if (!isInDropBand(drop.dropPct, cfg)) continue;
    const volumeJ = bars[bars.length - 1].volume;
    if (!passesLiquidity(drop.closeJ, volumeJ)) continue;
    out.push({
      symbol,
      closeJ: drop.closeJ,
      closeJPrev: drop.closeJPrev,
      dropPct: drop.dropPct,
      dollarVolume: drop.closeJ * volumeJ,
    });
  }
  // Tri profondeur : dropPct croissant (plus négatif d'abord). Tie-break sur
  // dollar-volume décroissant (liquidité).
  out.sort((a, b) => {
    if (a.dropPct !== b.dropPct) return a.dropPct - b.dropPct;
    return b.dollarVolume - a.dollarVolume;
  });
  return out;
}

/**
 * Filtre les candidats à ouvrir : retire ceux déjà détenus (anti-doublon).
 * Préserve l'ordre de tri.
 */
export function selectOversoldOpens(
  candidates: OversoldCandidate[],
  openSymbols: Set<string>,
): OversoldCandidate[] {
  return candidates.filter((c) => !openSymbols.has(c.symbol));
}

/**
 * Compte les jours OUVRÉS écoulés entre deux dates (week-ends exclus).
 *
 * Convention : on compte les jours ouvrés strictement APRÈS `from`, jusqu'à
 * `to` inclus. Ex : entrée vendredi, exit demande au vendredi suivant →
 * lun/mar/mer/jeu/ven = 5 jours ouvrés. Samedi/dimanche ne comptent pas.
 *
 * Jours fériés US non gérés en v1 (approximation acceptée par la spec §5.3).
 * Retourne 0 si `to <= from`.
 */
export function businessDaysSince(from: Date | string, to: Date | string): number {
  const start = typeof from === 'string' ? new Date(from) : from;
  const end = typeof to === 'string' ? new Date(to) : to;
  if (!(start instanceof Date) || isNaN(start.getTime())) return 0;
  if (!(end instanceof Date) || isNaN(end.getTime())) return 0;
  if (end.getTime() <= start.getTime()) return 0;

  // On itère par pas d'UN jour UTC à partir du lendemain de `start`.
  let count = 0;
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  // Avance d'un jour avant de compter (jour d'entrée = J0, pas compté).
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor.getTime() <= endDay.getTime()) {
    const dow = cursor.getUTCDay(); // 0 = dimanche, 6 = samedi
    if (dow !== 0 && dow !== 6) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}
