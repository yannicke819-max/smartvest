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
  /** Signal d'entrée BLOC 3 — null avant évaluation BLOC 3 ou si REJECT. */
  entrySignal?: GainersEntrySignal | null;
  rejectReason: CandidateRejectReason | null;
  /** BLOC 2 enrichissements (null avant BLOC 2). */
  spreadProxy: number | null;
  spreadProxySource: SpreadProxySource | null;
  trendFilter: TrendFilterKind | null;
  /** RVOL cumulatif intraday calculé en BLOC 1. */
  rvolIntraday: number | null;
  /**
   * BLOC 3 dry-run observability (issue #193 — P1 prereq PR6 shadow run).
   * Champs additionnels au decision_log pour audit post-hoc.
   * null avant l'évaluation BLOC 3.
   */
  bloc3Diagnostics?: Bloc3Diagnostics | null;
}

/**
 * BLOC 3 dry-run observability (issue #193).
 * Émis par GainersBloc3Service.evaluate() sur tous les candidats (ACCEPT et REJECT).
 */
export interface Bloc3Diagnostics {
  /** ISO 8601 du tick d'évaluation. */
  timestamp: string;
  /** Résolution des bougies fournies. */
  resolution: '1m' | '5m' | '1h' | 'daily';
  /**
   * Session inférée du timestamp + marketClass :
   * - RTH (regular trading hours equity US 14:30-21:00 UTC)
   * - PRE_MARKET (09:00-14:30 UTC equity)
   * - AFTER_HOURS (21:00-01:00 UTC equity)
   * - CRYPTO_24_7 (toujours pour crypto)
   * - UNKNOWN (impossible à déterminer)
   */
  session: 'RTH' | 'PRE_MARKET' | 'AFTER_HOURS' | 'CRYPTO_24_7' | 'UNKNOWN';
  /** Spread proxy fraction décimale (= spreadProxy ci-dessus, dupliqué pour decision_log). */
  spreadProxy: number | null;
  /**
   * Volume current candle / baseline 20j USD.
   * null si baseline absente (gainers_volume_baselines vide pour ce symbole).
   */
  volumeRatio: number | null;
  /**
   * true si BLOC 1 vol24h ≥ floor ET BLOC 2 spread ≤ cap.
   * false signale une raison déjà capturée par rejectReason (LIQUIDITY_FLOOR/SPREAD_TOO_WIDE).
   */
  gateLiquidityPassed: boolean;
  /** Nombre de pivots N=5 détectés (max 2 — un swingHigh + un swingLow). */
  pivotsDetected: number;
  /**
   * Raison absence de pivots si pivotsDetected = 0 :
   * - CANDLE_COUNT_BELOW_9 : moins de 9 bougies (besoin pour 2 pivots N=5 non chevauchés)
   * - INSUFFICIENT_SWING_AMPLITUDE : pivots existent mais swingHigh ≤ swingLow
   * - NOISE_TOO_HIGH : aucune bougie ne bat ses voisines (chaque pivot battu)
   * null si pivotsDetected ≥ 1.
   */
  pivotsReason: 'CANDLE_COUNT_BELOW_9' | 'INSUFFICIENT_SWING_AMPLITUDE' | 'NOISE_TOO_HIGH' | null;
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
