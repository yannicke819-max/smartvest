/**
 * ADR-005 Gainers Algo V1 — Types candidats et signaux des 4 blocs.
 * Aucune logique de calcul ici — types purs utilisés par les services PR2-PR5.
 */

import {
  CandidateRejectReason,
  EntryTriggerKind,
  ExitReason,
  InvalidationReason,
  SpreadProxySource,
  TrendFilterKind,
} from './gainers-enums';

/** Données brutes d'un candidat en entrée du pipeline (avant scoring BLOC 1). */
export interface GainersCandidateRaw {
  symbol: string;
  market: 'equity' | 'crypto';
  exchange: string;
  /** Prix de clôture ou last trade (USD). */
  close: number;
  open: number;
  high: number;
  low: number;
  /** Volume 24h (crypto) ou volume journalier (equity) en USD. */
  vol24hUsd: number;
  /** Médiane du volume journalier sur 20 jours de trading, en USD. */
  medianDailyVolUsd20d: number | null;
  /** Market cap : equity = shares_outstanding × close ; crypto = circ_supply × price. */
  marketCapUsd: number | null;
  /** ATR(14, daily) / close. Volatility clamp gate. */
  atrDailyRelative: number | null;
  /** Variation 1m qui a placé le candidat dans le top-gainers. */
  changePct1m: number;
  /** Score de persistance multi-TF P8. */
  persistenceScore: number | null;
  /** Texte "X/N" depuis P8 (ex : "4/6"). */
  persistenceCount: string | null;
  /** EMA50 daily — alimente le trend filter BLOC 1 (Golden Cross). */
  ema50Daily: number | null;
  /** EMA200 daily — alimente le trend filter BLOC 1 (Golden Cross). */
  ema200Daily: number | null;
}

/** Résultat du scoring BLOC 1 : candidat qualifié ou rejeté. */
export interface GainersScoredCandidate {
  raw: GainersCandidateRaw;
  /** null si REJECT, valeur composite [0..1] si ACCEPT. */
  compositeScore: number | null;
  decision: 'ACCEPT' | 'REJECT';
  rejectReason: CandidateRejectReason | null;
  /** BLOC 2 enrichissements (null avant BLOC 2). */
  spreadProxy: number | null;
  spreadProxySource: SpreadProxySource | null;
  trendFilter: TrendFilterKind | null;
  /** RVOL cumulatif intraday calculé en BLOC 1. */
  rvolIntraday: number | null;
}

/** Signal d'entrée produit par BLOC 3. */
export interface GainersEntrySignal {
  symbol: string;
  triggerKind: EntryTriggerKind;
  /** Prix pivot haut du swing (N=5 bougies). */
  swingHigh: number | null;
  /** Prix pivot bas du swing (N=5 bougies). */
  swingLow: number | null;
  /** Niveau de retracement Fibonacci utilisé (38.2, 50, 61.8). */
  fiboLevel: 38.2 | 50 | 61.8 | null;
  /** VWAP intraday au moment du signal. */
  vwap: number | null;
  /** EMA50 daily au moment du signal. */
  ema50Daily: number | null;
  /** EMA200 daily au moment du signal. */
  ema200Daily: number | null;
  detectedAt: string;
}

/** Signal de sortie / invalidation produit par BLOC 4. */
export interface GainersExitSignal {
  symbol: string;
  exitReason: ExitReason;
  invalidationReason: InvalidationReason | null;
  /** Prix de sortie effectif (ou estimé pour trailing). */
  exitPrice: number;
  /** MFE (Maximum Favorable Excursion) en pct depuis l'entrée au moment de la sortie. */
  mfePctAtExit: number | null;
  /** PnL estimé en pct. */
  estimatedPnlPct: number | null;
  detectedAt: string;
}

/**
 * Entrée du decision log — trace auditée par candidat et par bloc.
 * Alignée ADR-005 §5 schema audit-trail.
 */
export interface GainersDecisionLogEntry {
  candidateId: string;
  symbol: string;
  ts: string;
  algoVersion: 'v1';
  bloc: 1 | 2 | 3 | 4;
  signalObserved: string;
  decision: 'ACCEPT' | 'REJECT' | 'SKIP';
  reason: CandidateRejectReason | EntryTriggerKind | ExitReason | string | null;
  paramsCalculated: Record<string, unknown>;
  thresholdApplied: Record<string, unknown>;
  configSnapshot: Record<string, unknown>;
}
