/**
 * SetupClassifier — classification déterministe v1 des trades intraday au open.
 *
 * Step 3 du chain post-PR #577. Recherche web 02/06/2026 :
 *   - Zarattini SSRN 4729284 — ORB Stocks-in-Play, Sharpe 2.81
 *   - Marton & Cakir SSRN 4290787 — Hurst + SuperTrend intraday
 *   - Lopez de Prado SSRN 3517595 — Clustered Feature Importance
 *   - Dalton "Markets in Profile" — initiative vs responsive, 80% rule
 *   - Bookmap — absorption/exhaustion, CVD divergence (caveat : crypto only)
 *
 * Architecture :
 *   - 8 setup_kind (cross-cutting, niveau-2 shadow tant que n<100/cellule)
 *   - 3 regime_at_entry opérationnels (niveau-1 sizing × asset_class = 12 cellules)
 *   - Pure function — pas de DB, pas de LLM, pas de réseau
 *   - Features OPTIONNELLES tolérées : fallback en cascade selon disponibilité
 *
 * Limite v1 :
 *   - Pas de VWAP/EMA/ATR/ADX/RSI computés à l'open (besoin candles fetch dédié)
 *   - CVD/flow exclu (équités EODHD 5m sans tape granulaire — Agent 2 caveat)
 *   - Hurst 15m sur fenêtre courte = bruité (Marton & Cakir : Kalman filter v2)
 *   - Classifier dégrade gracieusement : si features riches absentes, mappe via
 *     persistence + path_eff + momentum + bucket Phase 3 déjà calculés.
 */

export type SetupKind =
  | 'ORB_BREAKOUT'
  | 'VWAP_RECLAIM'
  | 'VWAP_FADE'
  | 'MOMENTUM_BREAKOUT'
  | 'TREND_PULLBACK'
  | 'MEAN_REVERSION'
  | 'GAP_FADE'
  | 'CHOP_NOISE';

export type RegimeAtEntry = 'TREND_PORTEUR' | 'RANGE_CALME' | 'VOLATILE_CHOPPY';

export const CLASSIFIER_VERSION = 'v1' as const;

/**
 * Input features pour classification. Required = toujours disponible dans
 * TopGainerCandidate au moment de l'open. Optional = features avancées à fournir
 * si computées en upstream (v2 : VWAP/EMA/ATR/ADX/RSI via candles 1m/5m).
 */
export interface SetupClassifierInput {
  /** % de variation 1m au open. */
  changePct: number;
  /** Prix close au open. */
  close: number;
  /** High intraday observé jusqu'au open. */
  high: number;
  /** Volume 1m au open. */
  volume: number;
  /** Volume moyen 50 jours (proxy liquidity baseline). */
  avgVol50d: number;

  /** Persistence score multi-TF (P8). Fraction TFs positifs [0..1]. */
  persistenceScore: number;
  /** Path efficiency [0..1] (P9-UX). Indicateur smooth vs choppy. */
  pathEfficiency?: number;

  /** Momentum Phase 2 scanner (optionnel). */
  momentum?: {
    /** Gradient %/min. */
    gradientPctPerMin: number;
    /** Accélération (positif = pump, négatif = décélération). */
    acceleration: number;
    /** Score [0..1] verticality (pump parabolique vs sweet). */
    verticalityScore: number;
    /** Score [0..1] rising (trend confirmation). */
    risingScore: number;
  };
  /** Bucket Phase 3 (optionnel). */
  bucket?: 'sweet_spot_rising' | 'peak_parabolic' | 'early_mover' | 'stalled' | 'reversing';

  // Optional advanced indicators (v2 : à wirer quand VWAP/EMA/ATR computés à l'open)
  /** VWAP intraday. */
  vwap?: number;
  /** EMA 9 bars. */
  ema9?: number;
  /** EMA 21 bars. */
  ema21?: number;
  /** ATR 14 bars. */
  atr?: number;
  /** ADX 14 bars (force trend [0..100]). */
  adx?: number;
  /** RSI 14 bars [0..100]. */
  rsi?: number;
  /** Prix close veille (pour gap). */
  prevClose?: number;
  /** Minutes depuis l'open du marché (pour ORB priority). */
  minutesSinceMarketOpen?: number;
}

export interface SetupClassifierOutput {
  setup_kind: SetupKind;
  regime_at_entry: RegimeAtEntry;
  classifier_version: typeof CLASSIFIER_VERSION;
  /** Liste des features qui ont contribué à la décision (audit / debug). */
  features_used: string[];
}

/**
 * Classifie un setup au moment de l'open. Pure function, idempotente.
 *
 * Ordre de priorité (Agent 5 + adaptation features SmartVest) :
 *   1. ORB priority dans 60 premières min de session (si features avancées dispo)
 *   2. VWAP-based (RECLAIM / FADE) si VWAP + ATR fournis
 *   3. ADX-based (MOMENTUM_BREAKOUT / TREND_PULLBACK / MEAN_REVERSION) si ADX
 *   4. GAP_FADE si prevClose fourni
 *   5. Fallback v1 : utilise momentum/bucket/persistence/path_eff pour mapping
 *      grossier mais reproductible (la majorité des opens SmartVest passent ici).
 *
 * Si features insuffisantes pour toute classification → CHOP_NOISE.
 */
export function classifySetup(f: SetupClassifierInput): SetupClassifierOutput {
  const featuresUsed: string[] = [];
  const volRatio = f.avgVol50d > 0 ? f.volume / f.avgVol50d : 1;
  const volSpike = volRatio > 1.5;
  const closeToHigh = f.high > 0 ? f.close / f.high : 0;

  // ─── SETUP_KIND classification ───────────────────────────────────────────

  let setup_kind: SetupKind = 'CHOP_NOISE';

  // 1. ORB priority dans 60 premières min — exige minutesSinceMarketOpen + volSpike
  if (
    setup_kind === 'CHOP_NOISE' &&
    f.minutesSinceMarketOpen !== undefined &&
    f.minutesSinceMarketOpen <= 60 &&
    volSpike &&
    closeToHigh >= 0.99
  ) {
    setup_kind = 'ORB_BREAKOUT';
    featuresUsed.push('orb_window', 'volSpike', 'closeToHigh');
  }

  // 2. VWAP-based — exige vwap + atr
  if (
    setup_kind === 'CHOP_NOISE' &&
    f.vwap !== undefined &&
    f.atr !== undefined &&
    f.atr > 0
  ) {
    const aboveVWAP = f.close > f.vwap;
    const distVwapAtr = Math.abs(f.close - f.vwap) / f.atr;
    const trendUp =
      f.ema9 !== undefined && f.ema21 !== undefined
        ? f.ema9 > f.ema21 && f.close > f.ema21
        : f.changePct > 0;
    if (aboveVWAP && distVwapAtr < 0.3 && trendUp && volSpike) {
      setup_kind = 'VWAP_RECLAIM';
      featuresUsed.push('vwap_reclaim');
    } else if (!aboveVWAP && distVwapAtr < 0.3 && !trendUp) {
      setup_kind = 'VWAP_FADE';
      featuresUsed.push('vwap_fade');
    }
  }

  // 3. ADX-based
  if (setup_kind === 'CHOP_NOISE' && f.adx !== undefined) {
    const trendUp = f.changePct > 0;
    if (f.adx > 25 && trendUp && volSpike) {
      setup_kind = 'MOMENTUM_BREAKOUT';
      featuresUsed.push('adx_momentum');
    } else if (
      f.adx > 20 &&
      trendUp &&
      f.persistenceScore > 0.5
    ) {
      setup_kind = 'TREND_PULLBACK';
      featuresUsed.push('adx_pullback');
    } else if (
      f.adx < 20 &&
      f.rsi !== undefined &&
      (f.rsi < 30 || f.rsi > 70)
    ) {
      setup_kind = 'MEAN_REVERSION';
      featuresUsed.push('adx_meanrev');
    }
  }

  // 4. GAP_FADE — exige prevClose + early session
  if (setup_kind === 'CHOP_NOISE' && f.prevClose !== undefined && f.prevClose > 0) {
    const gapPct = (f.close - f.prevClose) / f.prevClose;
    if (
      Math.abs(gapPct) > 0.02 &&
      (f.minutesSinceMarketOpen === undefined || f.minutesSinceMarketOpen < 30) &&
      !volSpike
    ) {
      setup_kind = 'GAP_FADE';
      featuresUsed.push('gap_fade');
    }
  }

  // 5. Fallback v1 — utilise features SmartVest natives (momentum Phase 2, bucket Phase 3)
  if (setup_kind === 'CHOP_NOISE' && f.momentum) {
    const m = f.momentum;
    if (m.verticalityScore > 0.7 && m.risingScore > 0.7 && volSpike) {
      setup_kind = 'MOMENTUM_BREAKOUT';
      featuresUsed.push('momentum_breakout');
    } else if (m.acceleration < -0.005 && f.persistenceScore > 0.5 && f.changePct > 0) {
      setup_kind = 'TREND_PULLBACK';
      featuresUsed.push('momentum_decel_pullback');
    } else if (m.gradientPctPerMin < 0 && m.acceleration < 0) {
      setup_kind = 'MEAN_REVERSION';
      featuresUsed.push('momentum_reversal');
    }
  }
  if (setup_kind === 'CHOP_NOISE' && f.bucket) {
    // Phase 3 bucket → setup_kind mapping (fallback coarse)
    const bucketMap: Record<NonNullable<SetupClassifierInput['bucket']>, SetupKind> = {
      sweet_spot_rising: 'TREND_PULLBACK',
      peak_parabolic: 'MOMENTUM_BREAKOUT',
      early_mover: 'MOMENTUM_BREAKOUT',
      stalled: 'CHOP_NOISE',
      reversing: 'MEAN_REVERSION',
    };
    setup_kind = bucketMap[f.bucket];
    if (setup_kind !== 'CHOP_NOISE') featuresUsed.push(`bucket_${f.bucket}`);
  }

  // ─── REGIME_AT_ENTRY classification ──────────────────────────────────────
  // Cascade : préférer ADX + Hurst si dispo, sinon fallback persistence + path_eff.

  let regime_at_entry: RegimeAtEntry = 'RANGE_CALME';

  if (f.adx !== undefined) {
    // Path avancé v2 — ADX + persistence
    const verticality = f.momentum?.verticalityScore ?? 0.5;
    if (f.adx > 25 && f.persistenceScore > 0.55 && verticality > 0.5) {
      regime_at_entry = 'TREND_PORTEUR';
      featuresUsed.push('regime_adx_trend');
    } else if (
      f.pathEfficiency !== undefined && f.pathEfficiency < 0.4
    ) {
      regime_at_entry = 'VOLATILE_CHOPPY';
      featuresUsed.push('regime_choppy_pathEff');
    } else if (f.adx < 20) {
      regime_at_entry = 'RANGE_CALME';
      featuresUsed.push('regime_range_lowAdx');
    } else {
      regime_at_entry = 'RANGE_CALME';
      featuresUsed.push('regime_default');
    }
  } else {
    // Fallback v1 — persistence + path_eff + momentum
    const pathEff = f.pathEfficiency;
    const verticality = f.momentum?.verticalityScore;

    if (pathEff !== undefined && pathEff < 0.4) {
      regime_at_entry = 'VOLATILE_CHOPPY';
      featuresUsed.push('regime_choppy_v1');
    } else if (
      f.persistenceScore >= 0.55 &&
      (pathEff === undefined || pathEff >= 0.6) &&
      (verticality === undefined || verticality < 0.85)
    ) {
      regime_at_entry = 'TREND_PORTEUR';
      featuresUsed.push('regime_trend_v1');
    } else {
      regime_at_entry = 'RANGE_CALME';
      featuresUsed.push('regime_range_v1');
    }
  }

  return {
    setup_kind,
    regime_at_entry,
    classifier_version: CLASSIFIER_VERSION,
    features_used: featuresUsed,
  };
}
