/**
 * ADR-005 Gainers Algo V1 — Enums officiels des 4 blocs.
 * Toute la logique métier vit dans les services BLOC 1-4 (PR2-PR5).
 */

/** BLOC 1 — Raison de rejet d'un candidat à l'entrée du pipeline. */
export enum CandidateRejectReason {
  /** Median daily $vol 20j < $10M (equity) ou 24h $vol < $50M (crypto). */
  LIQUIDITY_FLOOR = 'LIQUIDITY_FLOOR',
  /** Market cap < $300M (equity) ou < $500M (crypto). */
  MARKET_CAP_MIN = 'MARKET_CAP_MIN',
  /** ATR(14, daily) / close > 0.15. */
  VOLATILITY_CLAMP = 'VOLATILITY_CLAMP',
  /** Spread proxy median (H-L)×0.5/close > 0.30%. */
  SPREAD_TOO_WIDE = 'SPREAD_TOO_WIDE',
  /** RVOL cumulatif intraday < seuil configuré. */
  RVOL_INSUFFICIENT = 'RVOL_INSUFFICIENT',
  /** Score de persistance multi-TF < gainers_min_persistence_score. */
  PERSISTENCE_BELOW_THRESHOLD = 'PERSISTENCE_BELOW_THRESHOLD',
  /** EMA50 daily < EMA200 daily (Golden Cross non formé). */
  TREND_FILTER_FAIL = 'TREND_FILTER_FAIL',
  /** Symbole absent de l'univers non-regression watchlist_hash vérifié. */
  UNIVERSE_GUARD = 'UNIVERSE_GUARD',
  /** Aucun trigger BLOC 3 détecté (pullback_HL_fibo ou vwap_reclaim). */
  NO_ENTRY_TRIGGER = 'NO_ENTRY_TRIGGER',
}

/** BLOC 3 — Nature du signal déclenchant l'entrée en position. */
export enum EntryTriggerKind {
  /** Pullback sur pivot swing N=5, retrace Fibonacci 38.2–61.8% (Bulkowski 2021). */
  PULLBACK_HL_FIBO = 'PULLBACK_HL_FIBO',
  /** Prix reclaim du VWAP intraday avec EMA50 > EMA200 daily. */
  VWAP_RECLAIM = 'VWAP_RECLAIM',
}

/** BLOC 2 — Filtre de tendance appliqué avant l'évaluation du trigger. */
export enum TrendFilterKind {
  /** EMA50 > EMA200 sur le daily — Golden Cross empirique (+13pp win-rate). */
  EMA_GOLDEN_CROSS = 'EMA_GOLDEN_CROSS',
  /** Aucun filtre de tendance (désactivé via config). */
  NONE = 'NONE',
}

/** BLOC 2 — Source utilisée pour le calcul du spread proxy. */
export enum SpreadProxySource {
  /** Médiane (H-L)×0.5/close sur les 5 dernières bougies 1m avec vol > 0. */
  HL_1M_MEDIAN = 'HL_1M_MEDIAN',
  /** Médiane sur bougies 5m (equity EODHD sans accès 1m natif). */
  HL_5M_MEDIAN = 'HL_5M_MEDIAN',
  /** Cap statique 0.30% appliqué quand < 3/5 bougies avec vol > 0. */
  STATIC_CAP_FALLBACK = 'STATIC_CAP_FALLBACK',
}

/** BLOC 4 — Raison d'invalidation d'un setup actif. */
export enum InvalidationReason {
  /** Stop-loss touché. */
  SL_HIT = 'SL_HIT',
  /** Take-profit complet atteint. */
  TP_HIT = 'TP_HIT',
  /** MFE ≥ 40% du TP → stop ramené au breakeven. */
  TRAILING_BREAKEVEN_TRIGGERED = 'TRAILING_BREAKEVEN_TRIGGERED',
  /** MFE ≥ 70% du TP → lock 50% TP. */
  TRAILING_LOCK_50_TRIGGERED = 'TRAILING_LOCK_50_TRIGGERED',
  /** Durée max de détention dépassée (horizon < 3h). */
  TIME_LIMIT_EXCEEDED = 'TIME_LIMIT_EXCEEDED',
  /** Score de persistance multi-TF tombé sous le plancher post-entrée. */
  PERSISTENCE_LOST = 'PERSISTENCE_LOST',
  /** Spread proxy remonté au-delà du cap post-entrée. */
  SPREAD_EXPANDED = 'SPREAD_EXPANDED',
  /** Cassure de structure : prix < swing low N=5 post-signal pullback. */
  STRUCTURE_BREAK = 'STRUCTURE_BREAK',
}

/** BLOC 4 — Raison de clôture de position. */
export enum ExitReason {
  /** Take-profit complet. */
  TP_FULL = 'TP_FULL',
  /** Lock partiel 50% du TP (MFE ≥ 70%). */
  TP_PARTIAL_LOCK = 'TP_PARTIAL_LOCK',
  /** Stop-loss. */
  SL = 'SL',
  /** Trailing stop ramené au breakeven (MFE ≥ 40%). */
  TRAILING_BREAKEVEN = 'TRAILING_BREAKEVEN',
  /** Trailing lock 50% TP déclenché. */
  TRAILING_LOCK = 'TRAILING_LOCK',
  /** Durée max de détention dépassée. */
  TIME_LIMIT = 'TIME_LIMIT',
  /** Invalidation générique (persistence lost, spread expanded, etc.). */
  INVALIDATION = 'INVALIDATION',
}

/** État courant du scanner Gainers — utilisé par le module d'observabilité. */
export enum ScannerStatus {
  IDLE = 'IDLE',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  ERROR = 'ERROR',
}
