/**
 * Bug #R1 / #R2 / #R6 — Helper warmup SL partagé.
 *
 * Décision unifiée pour TOUS les chemins de fermeture SL (`closed_stop`)
 * sur les `lisa_positions`. Subsume :
 *   - Bug #R1 (PR #319) : logique warmup 15 min inline dans
 *     `mechanical-trading.service.ts checkStopTarget`.
 *   - Bug #R2 (PR #320 fermée au profit de R6) : paramétrisation env vars
 *     `GAINERS_SL_WARMUP_MIN` + `GAINERS_SL_WARMUP_CATASTROPHIC_PCT` avec
 *     validation des bornes.
 *   - Bug #R6 : extension à `risk-monitor.service.ts checkPositionLimits`,
 *     2e chemin SL identifié (3 leaks asia_equity la nuit 14→15/05).
 *
 * Placement : `packages/ai-analyst` car importé par `risk-monitor` (déjà
 * dans ai-analyst) ET `mechanical-trading` (apps/api peut importer ai-analyst).
 * L'inverse n'est pas possible (sens de dépendance) — cf. arbitrage Bug #M4.
 *
 * Comportement (cas modéré <15min) : retourne shouldHonorStop=false → le
 * caller doit SKIP le close et laisser la position être réexaminée au tick
 * suivant. checkReactiveSignals (2e ligne défense) reste actif.
 */

const DEFAULT_WARMUP_MIN = 15;
const DEFAULT_SEVERE_LOSS_PCT = -3.0;
const MAX_WARMUP_MIN_BOUND = 60;
const MIN_SEVERE_LOSS_PCT_BOUND = -10;

type WarnLogger = { warn: (msg: string) => void };

/**
 * Résout `GAINERS_SL_WARMUP_MIN` avec validation. Bug #R2 subsumé.
 *   - NaN / négatif → fallback 15 (warn si logger fourni)
 *   - >60 → cap 60 (warn) — suspect mais pas invalide
 */
function resolveWarmupMin(rawStr: string | undefined, logger?: WarnLogger): number {
  const raw = Number(rawStr ?? DEFAULT_WARMUP_MIN);
  if (!Number.isFinite(raw) || raw < 0) {
    logger?.warn(
      `[SL_WARMUP] GAINERS_SL_WARMUP_MIN invalid (${rawStr}) — fallback ${DEFAULT_WARMUP_MIN}min`,
    );
    return DEFAULT_WARMUP_MIN;
  }
  if (raw > MAX_WARMUP_MIN_BOUND) {
    logger?.warn(
      `[SL_WARMUP] GAINERS_SL_WARMUP_MIN=${raw} suspicious — capped at ${MAX_WARMUP_MIN_BOUND}min`,
    );
    return MAX_WARMUP_MIN_BOUND;
  }
  return raw;
}

/**
 * Résout `GAINERS_SL_WARMUP_CATASTROPHIC_PCT` avec validation. Bug #R2 subsumé.
 *   - NaN / positif → fallback -3 (warn) — doit être négatif (= perte sévère)
 *   - <-10 → cap -10 (warn) — too lenient, le garde-fou ne se déclencherait plus
 */
function resolveWarmupCatastrophicPct(rawStr: string | undefined, logger?: WarnLogger): number {
  const raw = Number(rawStr ?? DEFAULT_SEVERE_LOSS_PCT);
  if (!Number.isFinite(raw) || raw > 0) {
    logger?.warn(
      `[SL_WARMUP] GAINERS_SL_WARMUP_CATASTROPHIC_PCT invalid (${rawStr}, should be negative) — fallback ${DEFAULT_SEVERE_LOSS_PCT}`,
    );
    return DEFAULT_SEVERE_LOSS_PCT;
  }
  if (raw < MIN_SEVERE_LOSS_PCT_BOUND) {
    logger?.warn(
      `[SL_WARMUP] GAINERS_SL_WARMUP_CATASTROPHIC_PCT=${raw} too lenient — capped at ${MIN_SEVERE_LOSS_PCT_BOUND}`,
    );
    return MIN_SEVERE_LOSS_PCT_BOUND;
  }
  return raw;
}

export interface WarmupDecision {
  /** True = le caller doit fermer (SL honoré). False = caller skip ce cycle. */
  shouldHonorStop: boolean;
  /**
   * - `warmup_skip` : position fraîche, perte modérée → on ignore le SL
   * - `warmup_override_severe_loss` : position fraîche mais perte sévère →
   *   garde-fou catastrophique, SL honoré
   * - `sl_honored_post_warmup` : warmup terminé, SL classique
   * - `no_timestamp` : entry_timestamp absent / invalide → SL honoré (conservateur)
   */
  reason:
    | 'sl_honored_post_warmup'
    | 'warmup_skip'
    | 'warmup_override_severe_loss'
    | 'no_timestamp';
  ageMin: number;
  unrealizedPnlPct: number;
  /** Valeur résolue de la fenêtre, pour log/traçabilité config active. */
  warmupMin: number;
  /** Valeur résolue du seuil catastrophique, pour log. */
  severeLossPct: number;
}

/**
 * Évalue si un SL doit être honoré, sur la base de l'âge de la position et
 * du P&L latent direction-aware.
 *
 * @param entryTimestamp Date ISO string ou Date. Si absent / invalide →
 *   shouldHonorStop=true (conservateur — on ne masque jamais un SL si on
 *   ne connaît pas l'âge).
 * @param entryPrice prix d'entrée (number). Suppose > 0.
 * @param livePrice prix live (number). Suppose validé par le caller
 *   (cf. Bug #R5 sanity bounds) avant cet appel.
 * @param isLong true pour long/long_call/long_put ; false pour short/short_*.
 *   Détermine le signe du P&L latent (négatif = perte pour les 2 sens).
 * @param config (optionnel) override des paramètres + logger pour les warns
 *   de validation des env vars. Si `warmupMin` / `severeLossPct` fournis,
 *   les env vars sont ignorées (utile pour les tests).
 */
export function evaluateWarmup(
  entryTimestamp: string | Date | null | undefined,
  entryPrice: number,
  livePrice: number,
  isLong: boolean,
  config?: {
    warmupMin?: number;
    severeLossPct?: number;
    logger?: WarnLogger;
  },
): WarmupDecision {
  const warmupMin = config?.warmupMin
    ?? resolveWarmupMin(process.env.GAINERS_SL_WARMUP_MIN, config?.logger);
  const severeLossPct = config?.severeLossPct
    ?? resolveWarmupCatastrophicPct(process.env.GAINERS_SL_WARMUP_CATASTROPHIC_PCT, config?.logger);

  if (entryTimestamp == null) {
    return {
      shouldHonorStop: true,
      reason: 'no_timestamp',
      ageMin: Infinity,
      unrealizedPnlPct: 0,
      warmupMin,
      severeLossPct,
    };
  }
  const entryMs = entryTimestamp instanceof Date
    ? entryTimestamp.getTime()
    : new Date(entryTimestamp).getTime();
  if (!Number.isFinite(entryMs)) {
    return {
      shouldHonorStop: true,
      reason: 'no_timestamp',
      ageMin: Infinity,
      unrealizedPnlPct: 0,
      warmupMin,
      severeLossPct,
    };
  }

  const ageMin = (Date.now() - entryMs) / 60_000;
  const unrealizedPnlPct = isLong
    ? ((livePrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - livePrice) / entryPrice) * 100;

  const inWarmup = ageMin < warmupMin;
  const severeLoss = unrealizedPnlPct <= severeLossPct;

  if (inWarmup && !severeLoss) {
    return {
      shouldHonorStop: false,
      reason: 'warmup_skip',
      ageMin,
      unrealizedPnlPct,
      warmupMin,
      severeLossPct,
    };
  }
  if (inWarmup && severeLoss) {
    return {
      shouldHonorStop: true,
      reason: 'warmup_override_severe_loss',
      ageMin,
      unrealizedPnlPct,
      warmupMin,
      severeLossPct,
    };
  }
  return {
    shouldHonorStop: true,
    reason: 'sl_honored_post_warmup',
    ageMin,
    unrealizedPnlPct,
    warmupMin,
    severeLossPct,
  };
}

/** Helper de log structuré conforme au pattern `[SL_WARMUP]` du repo. */
export function formatWarmupLog(
  decision: WarmupDecision,
  context: { symbol: string; positionId: string; service: string; slPrice?: string | null },
): string {
  return (
    `[SL_WARMUP] ${context.symbol} decision=${decision.reason} ` +
    `service=${context.service} position_id=${context.positionId} ` +
    `age_min=${decision.ageMin === Infinity ? 'Infinity' : decision.ageMin.toFixed(2)} ` +
    `unrealized_pnl_pct=${decision.unrealizedPnlPct.toFixed(3)} ` +
    (context.slPrice != null ? `sl_price=${context.slPrice} ` : '') +
    `warmup_min_config=${decision.warmupMin} ` +
    `warmup_catastrophic_pct_config=${decision.severeLossPct}`
  );
}
