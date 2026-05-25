/**
 * AXEES T2-C — Macro Regime Detector.
 *
 * Orthogonal au TacticalRegimeClassifier (BTC-focused intraday) : ce module
 * détecte le régime MACRO cross-asset sur un horizon multi-jours à semaines,
 * à partir d'inputs déjà disponibles dans MarketSnapshot (cf. CLAUDE.md
 * §6quater : cascade live → proxy ETF → fallback).
 *
 * Vision AXEES :
 *
 *   "Remplacer les seuils statiques (VIX>30, pnl7d) par un détecteur formel
 *    à 4 états. Chaque stratégie déclare ses régimes favoris. En EUPHORIA on
 *    baisse les sizing, en PANIC on relève les seuils de quarantine."
 *
 * Les 4 régimes :
 *
 *   RISK_ON   : vol contenue, term spread positif, credit serré.
 *               Sizing nominal, BUY autorisés, stratégies momentum favorisées.
 *   RISK_OFF  : vol modérée mais credit qui s'écarte, spread plat/négatif.
 *               Sizing -20%, BUY plus sélectifs, stratégies mean-reversion favorisées.
 *   EUPHORIA  : vol très basse, credit ultra-serré, complaisance générale.
 *               Sizing -30%, BUY ultra-sélectifs (risque de retournement),
 *               stratégies path quality très strictes.
 *   PANIC     : VIX > 35, credit blow-out, flight to quality.
 *               BUY suspendus, CLOSE accéléré, seuils quarantine relevés.
 *
 * Algorithme : système de scoring par feature. Chaque feature contribue
 * un score [-2..+2] vers chaque régime. Le régime gagnant = max score
 * agrégé. Confidence = winnerScore / totalAbsScore.
 *
 * Pure fn déterministe, testable sans I/O.
 */

import type { TradingDecision } from './trading-decision';

export type MacroRegime = 'RISK_ON' | 'RISK_OFF' | 'EUPHORIA' | 'PANIC' | 'UNKNOWN';

/**
 * Inputs macro. Tous optionnels — le détecteur dégrade gracieusement quand
 * une feature est indisponible (fallback / proxy ETF / source down).
 */
export interface MacroRegimeInputs {
  /** VIX spot. Null si indisponible. */
  vix?: number | null;
  /** Term spread US10Y - US2Y en bps. ex: 50 = +50bps. Null si indispo. */
  termSpreadBps?: number | null;
  /** HY OAS (High Yield credit spread) en bps. ex: 350. Null si indispo. */
  hyOasBps?: number | null;
  /** IG OAS (Investment Grade credit spread) en bps. ex: 95. Null si indispo. */
  igOasBps?: number | null;
  /** DXY (US Dollar Index) spot. ex: 104.5. Null si indispo. */
  dxy?: number | null;
  /** Variation DXY sur 5 jours en %. ex: +1.5. Optionnel. */
  dxyChange5dPct?: number | null;
  /** Drapeau qualité données : si true, la source est dégradée (proxy/fallback). */
  dataQualityDegraded?: boolean;
}

export interface RegimeVerdict {
  regime: MacroRegime;
  /** Confidence 0..1 du verdict (ratio du score gagnant / total). */
  confidence: number;
  /** Scores aggrégés par régime (debug + explainability). */
  scores: Record<Exclude<MacroRegime, 'UNKNOWN'>, number>;
  /** Features qui ont contribué (audit + debug). */
  contributingFeatures: ReadonlyArray<{
    feature: string;
    value: number;
    contributions: Partial<Record<Exclude<MacroRegime, 'UNKNOWN'>, number>>;
  }>;
  /** Verdict TradingDecision suggéré par défaut pour ce régime. */
  suggestedVerdict: TradingDecision;
  /** Rationale human-readable. */
  rationale: string;
}

/**
 * Seuils calibrés sur données historiques 2018-2026 US.
 * Ajustables via override partiel dans detectMacroRegime(input, thresholdsOverride?).
 */
export interface MacroRegimeThresholds {
  /** VIX seuils par régime. */
  vixEuphoriaMax: number;     // < 12 = EUPHORIA bias
  vixRiskOnMax: number;        // < 18 = RISK_ON bias
  vixRiskOffMin: number;       // > 22 = RISK_OFF bias
  vixPanicMin: number;         // > 35 = PANIC bias

  /** Term spread (10Y-2Y) en bps. */
  termInversionBps: number;    // < 0 = RISK_OFF
  termSteepBps: number;        // > 100 = RISK_ON

  /** HY OAS en bps. */
  hyOasUltraTight: number;     // < 280 = EUPHORIA
  hyOasNormal: number;         // 280..450 = RISK_ON neutral
  hyOasWide: number;           // > 500 = RISK_OFF
  hyOasBlowout: number;        // > 700 = PANIC
}

export const DEFAULT_MACRO_REGIME_THRESHOLDS: MacroRegimeThresholds = {
  vixEuphoriaMax: 12,
  vixRiskOnMax: 18,
  vixRiskOffMin: 22,
  vixPanicMin: 35,
  termInversionBps: 0,
  termSteepBps: 100,
  hyOasUltraTight: 280,
  hyOasNormal: 450,
  hyOasWide: 500,
  hyOasBlowout: 700,
};

type ConcreteRegime = Exclude<MacroRegime, 'UNKNOWN'>;

/**
 * Détecte le régime macro courant à partir des inputs cross-asset.
 *
 * Algorithme :
 *   1. Pour chaque feature présente, calcule contributions [-2..+2] par régime
 *   2. Agrège : winnerRegime = argmax(scores), confidence = winner / totalAbs
 *   3. Si total absolu = 0 (pas de feature) → UNKNOWN avec confidence=0
 *   4. Si données degraded → confidence × 0.7 (haircut data quality)
 *
 * Suggested verdicts par régime :
 *   RISK_ON   → HOLD (sizing nominal, BUY ailleurs autorisés)
 *   RISK_OFF  → REDUCE_SIZE (sizing -20%)
 *   EUPHORIA  → REDUCE_SIZE (sizing -30%, complaisance)
 *   PANIC     → MARKET_UNSAFE (suspend nouvelles ouvertures, accélère CLOSE)
 *   UNKNOWN   → REGIME_UNKNOWN (conservative skip)
 */
export function detectMacroRegime(
  inputs: MacroRegimeInputs,
  thresholds: MacroRegimeThresholds = DEFAULT_MACRO_REGIME_THRESHOLDS,
): RegimeVerdict {
  const scores: Record<ConcreteRegime, number> = {
    RISK_ON: 0,
    RISK_OFF: 0,
    EUPHORIA: 0,
    PANIC: 0,
  };
  const contributing: RegimeVerdict['contributingFeatures'] = [] as Array<{
    feature: string;
    value: number;
    contributions: Partial<Record<ConcreteRegime, number>>;
  }>;

  // Feature: VIX
  if (typeof inputs.vix === 'number' && inputs.vix > 0) {
    const contribs: Partial<Record<ConcreteRegime, number>> = {};
    const v = inputs.vix;
    if (v < thresholds.vixEuphoriaMax) {
      contribs.EUPHORIA = 2;
      contribs.RISK_ON = 1;
    } else if (v < thresholds.vixRiskOnMax) {
      contribs.RISK_ON = 2;
    } else if (v >= thresholds.vixPanicMin) {
      contribs.PANIC = 2;
      contribs.RISK_OFF = 1;
    } else if (v >= thresholds.vixRiskOffMin) {
      contribs.RISK_OFF = 2;
    }
    applyContribs(scores, contribs);
    (contributing as Array<unknown>).push({ feature: 'vix', value: v, contributions: contribs });
  }

  // Feature: term spread
  if (typeof inputs.termSpreadBps === 'number') {
    const contribs: Partial<Record<ConcreteRegime, number>> = {};
    const t = inputs.termSpreadBps;
    if (t < thresholds.termInversionBps) {
      contribs.RISK_OFF = 1;
    } else if (t > thresholds.termSteepBps) {
      contribs.RISK_ON = 1;
    }
    applyContribs(scores, contribs);
    if (Object.keys(contribs).length > 0) {
      (contributing as Array<unknown>).push({ feature: 'termSpreadBps', value: t, contributions: contribs });
    }
  }

  // Feature: HY OAS
  if (typeof inputs.hyOasBps === 'number' && inputs.hyOasBps > 0) {
    const contribs: Partial<Record<ConcreteRegime, number>> = {};
    const h = inputs.hyOasBps;
    if (h < thresholds.hyOasUltraTight) {
      contribs.EUPHORIA = 2;
      contribs.RISK_ON = 1;
    } else if (h <= thresholds.hyOasNormal) {
      contribs.RISK_ON = 1;
    } else if (h >= thresholds.hyOasBlowout) {
      contribs.PANIC = 2;
      contribs.RISK_OFF = 1;
    } else if (h >= thresholds.hyOasWide) {
      contribs.RISK_OFF = 2;
    }
    applyContribs(scores, contribs);
    (contributing as Array<unknown>).push({ feature: 'hyOasBps', value: h, contributions: contribs });
  }

  // Feature: DXY change 5d
  if (typeof inputs.dxyChange5dPct === 'number') {
    const contribs: Partial<Record<ConcreteRegime, number>> = {};
    const d = inputs.dxyChange5dPct;
    if (d > 2.0) {
      contribs.RISK_OFF = 1;
    } else if (d < -2.0) {
      contribs.RISK_ON = 1;
    }
    applyContribs(scores, contribs);
    if (Object.keys(contribs).length > 0) {
      (contributing as Array<unknown>).push({ feature: 'dxyChange5dPct', value: d, contributions: contribs });
    }
  }

  // Agrégation
  const totalAbs = Object.values(scores).reduce((acc, s) => acc + Math.abs(s), 0);
  if (totalAbs === 0) {
    return {
      regime: 'UNKNOWN',
      confidence: 0,
      scores,
      contributingFeatures: contributing,
      suggestedVerdict: 'REGIME_UNKNOWN',
      rationale: 'Aucune feature disponible pour détection de régime.',
    };
  }

  let winner: ConcreteRegime = 'RISK_ON';
  let winnerScore = -Infinity;
  for (const r of ['RISK_ON', 'RISK_OFF', 'EUPHORIA', 'PANIC'] as ConcreteRegime[]) {
    if (scores[r] > winnerScore) {
      winnerScore = scores[r];
      winner = r;
    }
  }

  let confidence = winnerScore > 0 ? winnerScore / totalAbs : 0;
  if (inputs.dataQualityDegraded) {
    confidence *= 0.7;
  }
  confidence = Math.max(0, Math.min(1, confidence));

  const suggestedVerdict = regimeToVerdict(winner);
  const rationale = `Régime ${winner} (score ${winnerScore}/${totalAbs}, confidence ${(confidence * 100).toFixed(0)}%${inputs.dataQualityDegraded ? ', data degraded' : ''}).`;

  return {
    regime: winnerScore <= 0 ? 'UNKNOWN' : winner,
    confidence,
    scores,
    contributingFeatures: contributing,
    suggestedVerdict: winnerScore <= 0 ? 'REGIME_UNKNOWN' : suggestedVerdict,
    rationale,
  };
}

function applyContribs(
  scores: Record<ConcreteRegime, number>,
  contribs: Partial<Record<ConcreteRegime, number>>,
): void {
  for (const k of Object.keys(contribs) as ConcreteRegime[]) {
    scores[k] += contribs[k] ?? 0;
  }
}

function regimeToVerdict(r: ConcreteRegime): TradingDecision {
  switch (r) {
    case 'RISK_ON':
      return 'HOLD';
    case 'RISK_OFF':
      return 'REDUCE_SIZE';
    case 'EUPHORIA':
      return 'REDUCE_SIZE';
    case 'PANIC':
      return 'MARKET_UNSAFE';
  }
}
