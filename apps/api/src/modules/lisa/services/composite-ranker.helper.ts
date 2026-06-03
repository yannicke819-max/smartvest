/**
 * Composite Ranker — Phase 1 du refactor scanner (Option C).
 *
 * Re-classe les candidats remontés par EODHD screener selon un score composite
 * au lieu du tri brut `refund_1d_p.desc` qui ne ramène que les paraboliques.
 *
 * Score = w1·sweetSpotProximity + w2·volumeStrength + w3·notAtPeakBonus
 *       + w4·mcapTier - w5·parabolicPenalty
 *
 *   sweetSpotProximity : 1 = au sweet-spot 3-15% changePct, 0 = très loin (recalibré 03/06)
 *   volumeStrength     : clamp(volumeRatio / 2, 0, 1) — surge volume = signal
 *   notAtPeakBonus     : 1 - closeToHighRatio — plus on est sous le high, plus on respire
 *   mcapTier           : tier 0 (<100M) à 1 (>10B), préférence mid/large pour liquidité
 *   parabolicPenalty   : pénalité forte si changePct > 15% (= au-delà du sweet-spot, recalibré 03/06)
 *
 * Architecture additive : remplace UNIQUEMENT l'ordre des candidats. Tous les
 * candidats remontés par EODHD restent dans la liste, juste mieux triés.
 * Mistral voit les mêmes fields, juste dans un ordre différent.
 *
 * Gated par env SCANNER_COMPOSITE_RANKING_ENABLED (default OFF) → zero risque
 * de régression. Si OFF, tri inchangé par refund_1d_p desc.
 *
 * Poids paramétrables via SCANNER_COMPOSITE_WEIGHTS (CSV 5 valeurs).
 *
 * Pas d'effet sur le set de candidats envoyés au TRADER — juste le top-N change.
 */

import type { TopGainerCandidate } from '@smartvest/ai-analyst';

/** Poids du score composite. Somme libre (le score est utilisé pour ranking, pas pour seuil absolu). */
export interface CompositeWeights {
  w1_sweetSpot: number;
  w2_volume: number;
  w3_notAtPeak: number;
  w4_mcap: number;
  w5_parabolicPenalty: number;
}

export const DEFAULT_COMPOSITE_WEIGHTS: CompositeWeights = {
  w1_sweetSpot: 0.30,
  w2_volume: 0.25,
  w3_notAtPeak: 0.20,
  w4_mcap: 0.10,
  w5_parabolicPenalty: 0.15,
};

/** Parse "0.3,0.25,0.2,0.1,0.15" en CompositeWeights. Fallback DEFAULT si invalide. */
export function parseCompositeWeights(raw: string | undefined): CompositeWeights {
  if (!raw || raw.trim().length === 0) return DEFAULT_COMPOSITE_WEIGHTS;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 5 || parts.some((p) => !Number.isFinite(p) || p < 0)) {
    return DEFAULT_COMPOSITE_WEIGHTS;
  }
  return {
    w1_sweetSpot: parts[0],
    w2_volume: parts[1],
    w3_notAtPeak: parts[2],
    w4_mcap: parts[3],
    w5_parabolicPenalty: parts[4],
  };
}

/** Sweet-spot proximity: cloche centrée sur 9% (= milieu du range gagnant 3-15%, recalibré 03/06). */
function sweetSpotProximity(changePct: number): number {
  if (!Number.isFinite(changePct)) return 0;
  const target = 9;
  const sigma = 6; // largeur de la cloche : tolère 3-15 confortablement
  const z = (changePct - target) / sigma;
  return Math.max(0, Math.exp(-(z * z) / 2));
}

/** Volume strength: clamp volumeRatio/2 à [0,1]. RVOL 2x = score max. */
function volumeStrength(volumeRatio: number | null | undefined): number {
  if (volumeRatio == null || !Number.isFinite(volumeRatio)) return 0;
  return Math.max(0, Math.min(1, volumeRatio / 2));
}

/** Not-at-peak bonus: 1 - closeToHighRatio. Plus on est sous le high, plus on a de marge. */
function notAtPeakBonus(closeToHighRatio: number | null | undefined): number {
  if (closeToHighRatio == null || !Number.isFinite(closeToHighRatio)) return 0;
  return Math.max(0, Math.min(1, 1 - closeToHighRatio));
}

/** Mcap tier: 0 si <100M, 0.5 si 100M-1B, 1 si >1B. Préférence liquidité. */
function mcapTier(marketCap: number | null | undefined): number {
  if (marketCap == null || !Number.isFinite(marketCap) || marketCap <= 0) return 0;
  if (marketCap >= 1_000_000_000) return 1;
  if (marketCap >= 100_000_000) return 0.5;
  return 0;
}

/** Parabolic penalty: 0 si <15%, ramp up vers 1 à 30%. Recalibré 03/06 — tue
 *  uniquement les vrais paraboliques (Korean limit-up +30%, US small cap mania).
 *  Avant : ramp 8-25 → pénalisait à tort la veine 9-15% (RPI/PRX/IFX rejetés). */
function parabolicPenalty(changePct: number): number {
  if (!Number.isFinite(changePct)) return 0;
  if (changePct <= 15) return 0;
  if (changePct >= 30) return 1;
  return (changePct - 15) / 15; // linéaire entre 15 et 30
}

/** Compute le score composite d'un candidat. Retourne valeur dans ~[-0.15, 0.85]. */
export function computeCompositeScore(
  c: { changePct?: number; close?: number; high?: number; volume?: number; avgVol50d?: number; marketCap?: number },
  weights: CompositeWeights = DEFAULT_COMPOSITE_WEIGHTS,
): number {
  const changePct = c.changePct ?? 0;
  const close = c.close ?? 0;
  const high = c.high ?? close;
  const volumeRatio = (c.avgVol50d ?? 0) > 0 ? (c.volume ?? 0) / (c.avgVol50d ?? 1) : null;
  const closeToHighRatio = high > 0 ? close / high : null;

  const score =
    weights.w1_sweetSpot * sweetSpotProximity(changePct)
    + weights.w2_volume * volumeStrength(volumeRatio)
    + weights.w3_notAtPeak * notAtPeakBonus(closeToHighRatio)
    + weights.w4_mcap * mcapTier(c.marketCap)
    - weights.w5_parabolicPenalty * parabolicPenalty(changePct);

  return score;
}

/**
 * Re-rank une liste de candidats par score composite (décroissant).
 * Les candidats avec score plus haut viennent en premier.
 *
 * Ne supprime AUCUN candidat — juste re-trie. Préserve l'objet original
 * (immutable pour le caller).
 */
export function rankByCompositeScore(
  candidates: TopGainerCandidate[],
  weights: CompositeWeights = DEFAULT_COMPOSITE_WEIGHTS,
): TopGainerCandidate[] {
  return [...candidates]
    .map((c) => ({ c, score: computeCompositeScore(c, weights) }))
    .sort((a, b) => b.score - a.score)
    .map(({ c }) => c);
}
