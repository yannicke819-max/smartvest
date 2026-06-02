/**
 * SkepticAgent — Pure helper de veto déterministe au moment de l'open.
 *
 * Step 1 du chain post-#578. Recherche web 02/06/2026 (5 agents parallèles,
 * 35+ sources canoniques). Architecture Option A étendue : pure function,
 * sous-règles internes, mode shadow|blocking par règle pour déploiement
 * progressif (pattern path_eff calibration 25/05).
 *
 * 6 familles de règles (sources institutionnelles) :
 *
 * 1. MICROSTRUCTURE — spread caps + stale quote
 *    - Bouchaud, Bonart, Donier, Gould "Trades, Quotes and Prices" Cambridge 2018
 *    - Almgren & Chriss "Optimal execution" J. of Risk 2000
 *    - Easley/Lopez de Prado/O'Hara "Flow Toxicity and Liquidity" (VPIN)
 *
 * 2. REGIME_MACRO — VIX/HY OAS/DXY/curve/events/geopolitical
 *    - BIS Bulletin 95 "Anatomy of VIX spike August 2024"
 *    - Caldara-Iacoviello "Measuring Geopolitical Risk" Fed IFDP 1222
 *    - Lopez de Prado ch.17 Structural Breaks (CUSUM)
 *
 * 3. CORRELATION — Pearson 30d + sector/class cap
 *    - Lopez de Prado "Hierarchical Risk Parity" SSRN
 *    - Meucci "Effective Number of Bets"
 *    - Choueifaty & Coignard "Toward Maximum Diversification" TOBAM/JPM 2008
 *
 * 4. DRAWDOWN — daily cap + consecutive losses + MAE
 *    - FTMO Academy "Maximum Daily Loss" (5% equity, midnight reset)
 *    - Sweeney "Maximum Adverse Excursion" Wiley 1996 (2R recovery odds < 25%)
 *    - Three-Loss Rule (EdgeFlo, Tradezella convergent)
 *
 * 5. LIQUIDITY — ADV participation cap
 *    - J.P. Morgan TCA guidelines
 *
 * 6. COOLDOWN — anti-revenge same ticker post-SL
 *    - Standard prop firm pattern
 *
 * Mode SHADOW par défaut sur toutes les règles. Activation BLOCKING via env
 * `SKEPTIC_RULE_<NAME>_MODE=blocking` après calibration via decision_log.
 */

export type SkepticRuleName =
  | 'microstructure'
  | 'regime_macro'
  | 'correlation'
  | 'drawdown'
  | 'liquidity'
  | 'cooldown';

export type SkepticSeverity = 'info' | 'warn' | 'block';

export type SkepticMode = 'shadow' | 'blocking';

export interface SkepticReason {
  rule: SkepticRuleName;
  triggered: boolean;
  severity: SkepticSeverity;
  /** Human-readable, ex: "spread 18bps > cap 12bps" */
  detail: string;
  /** Valeur numérique observée (pour audit). */
  metric: number;
  /** Seuil contre lequel metric est comparé. */
  threshold: number;
  /** Mode de la règle au moment de l'évaluation. */
  mode: SkepticMode;
}

export interface SkepticVerdict {
  /**
   * Décision finale : true si AU MOINS UNE règle en mode 'blocking'
   * a triggered avec severity='block'. False sinon (y compris shadow blocks).
   */
  veto: boolean;
  /** Composite : nb règles triggered / nb règles évaluées ∈ [0,1]. */
  score: number;
  /** Toutes les évaluations (mêmes les info), append-only audit. */
  reasons: SkepticReason[];
  /** Snapshot features inputs pour ML future training. */
  features: Record<string, number>;
  /** Version sémantique du SkepticAgent. */
  modelVersion: string;
}

/**
 * Config par règle. Chaque règle a son flag mode + seuils calibrés.
 * Les seuils peuvent venir d'env vars ou de DB lisa_session_configs.
 */
export interface SkepticConfig {
  microstructure: {
    mode: SkepticMode;
    /** spread bps par classe d'actif (cf. recherche Bouchaud). */
    spreadBpsMax: Partial<Record<AssetClassKey, number>>;
    /** age stale quote max ms. */
    staleMsMax: Partial<Record<AssetClassKey, number>>;
  };
  regime_macro: {
    mode: SkepticMode;
    vixHard: number; // 30 par défaut
    vixSoft: number; // 25 par défaut
    vixSpikePct1d: number; // 0.15 = +15% en 1 jour
    vvixHigh: number; // 110
    vvixVixRatioDivergence: number; // 7
    hyOasStress: number; // 800 bps
    hyOas5dDeltaBpsAlert: number; // 50 bps en 5j
    dxyVixZscoreCoSpike: number; // 2 sigma
    eventBlackoutBeforeMin: number; // 30 min avant FOMC/NFP/CPI/ECB
    eventBlackoutAfterMin: number; // 15 min après
  };
  correlation: {
    mode: SkepticMode;
    pairwiseMax: number; // 0.85 = same risk unit
    pairwiseCluster: number; // 0.70 = cluster
    avgClusterMin: number; // 0.65 avg AVEC >= 3 opens
    minOpensForAvg: number; // 3
    sectorCapPct: number; // 0.30
    assetClassCapPct: number; // 0.40
    betaSpyCap: number; // 1.5
  };
  drawdown: {
    mode: SkepticMode;
    dailyDdHardKill: number; // -0.03 (FTMO 1-step)
    dailyDdSoftWarn: number; // -0.02
    hourlyDdSoftWarn: number; // -0.015
    consecutiveLossesPause: number; // 3
    consecutiveLossesKill: number; // 5
    maeAtrMultipleExit: number; // 2.0 (Sweeney)
  };
  liquidity: {
    mode: SkepticMode;
    advPctMaxLarge: number; // 0.005 = 0.5% ADV
    advPctMaxSmall: number; // 0.01 = 1% ADV
    minAvgVol50d: Partial<Record<AssetClassKey, number>>;
  };
  cooldown: {
    mode: SkepticMode;
    revengeCooldownMinSameTicker: number; // 60 min
    revengeMinLossesPct: number; // -0.001 = -0.1%
  };
}

export type AssetClassKey =
  | 'us_equity_large'
  | 'us_equity_small_mid'
  | 'eu_equity'
  | 'asia_equity'
  | 'crypto_major'
  | 'crypto_alt'
  | 'fx_major'
  | 'fx_cross'
  | 'commodity';

/**
 * Default config — seuils issus de la recherche 02/06.
 * Mode SHADOW par défaut sur TOUTES les règles. Activer blocking règle par
 * règle après calibration via lisa_decision_log.
 */
export const DEFAULT_SKEPTIC_CONFIG: SkepticConfig = {
  microstructure: {
    mode: 'shadow',
    spreadBpsMax: {
      us_equity_large: 15,
      us_equity_small_mid: 150,
      eu_equity: 30,
      asia_equity: 50,
      crypto_major: 30,
      crypto_alt: 150,
      fx_major: 5,
      fx_cross: 15,
      commodity: 50,
    },
    staleMsMax: {
      us_equity_large: 2000,
      us_equity_small_mid: 5000,
      eu_equity: 2000,
      asia_equity: 5000,
      crypto_major: 1000,
      crypto_alt: 2000,
      fx_major: 500,
      fx_cross: 1000,
      commodity: 3000,
    },
  },
  regime_macro: {
    mode: 'shadow',
    vixHard: 30,
    vixSoft: 25,
    vixSpikePct1d: 0.15,
    vvixHigh: 110,
    vvixVixRatioDivergence: 7,
    hyOasStress: 800,
    hyOas5dDeltaBpsAlert: 50,
    dxyVixZscoreCoSpike: 2,
    eventBlackoutBeforeMin: 30,
    eventBlackoutAfterMin: 15,
  },
  correlation: {
    mode: 'shadow',
    pairwiseMax: 0.85,
    pairwiseCluster: 0.70,
    avgClusterMin: 0.65,
    minOpensForAvg: 3,
    sectorCapPct: 0.30,
    assetClassCapPct: 0.40,
    betaSpyCap: 1.5,
  },
  drawdown: {
    mode: 'shadow',
    dailyDdHardKill: -0.03,
    dailyDdSoftWarn: -0.02,
    hourlyDdSoftWarn: -0.015,
    consecutiveLossesPause: 3,
    consecutiveLossesKill: 5,
    maeAtrMultipleExit: 2.0,
  },
  liquidity: {
    mode: 'shadow',
    advPctMaxLarge: 0.005,
    advPctMaxSmall: 0.01,
    minAvgVol50d: {
      us_equity_large: 500_000,
      us_equity_small_mid: 500_000,
      eu_equity: 200_000,
      asia_equity: 200_000,
      crypto_major: 0,
      crypto_alt: 0,
      fx_major: 0,
      fx_cross: 0,
      commodity: 0,
    },
  },
  cooldown: {
    mode: 'shadow',
    revengeCooldownMinSameTicker: 60,
    revengeMinLossesPct: -0.001,
  },
};

/**
 * Input du SkepticAgent. Le caller fetche les features (DB, market snapshot,
 * positions ouvertes), l'agent est pure function.
 */
export interface SkepticInput {
  /** Candidat à évaluer. */
  candidate: {
    symbol: string;
    assetClass: AssetClassKey;
    close: number;
    /** Optionnel : spread basis points si dispo. */
    spreadBps?: number;
    /** Age en ms du dernier quote. */
    quoteAgeMs?: number;
    /** Notional USD demandé. */
    notionalUsd: number;
    /** Volume moyen 50j. */
    avgVol50d: number;
    /** Optionnel : secteur GICS. */
    sector?: string;
  };
  /** Snapshot macro au moment de l'évaluation. */
  macro: {
    vix?: number;
    /** % variation du VIX sur 1 jour, ex 0.20 = +20%. */
    vixPct1d?: number;
    /** VIX 1 mois / 3 mois pour term structure inversion. */
    vix1m?: number;
    vix3m?: number;
    vvix?: number;
    /** HY OAS en bps (proxy via HYG.US si dispo). */
    hyOasBps?: number;
    /** Variation HY OAS sur 5 jours en bps. */
    hyOas5dDeltaBps?: number;
    /** IG OAS en bps (proxy via LQD.US). */
    igOasBps?: number;
    /** Z-score DXY sur 20j. */
    dxyZscore20d?: number;
    /** Z-score VIX sur 20j. */
    vixZscore20d?: number;
    /** Variation US 10Y intraday en bp. */
    us10yIntradayBp?: number;
    /** Variation US 2Y intraday en bp. */
    us2yIntradayBp?: number;
    /** Spread courbe 2s10s en bp variation intraday. */
    curve2s10sIntradayBp?: number;
    /** Minutes jusqu'au prochain event macro impact 'HIGH'. */
    minutesToHighImpactEvent?: number;
    /** Minutes écoulées depuis dernier event impact 'HIGH'. */
    minutesSinceHighImpactEvent?: number;
    /** Daily GPR index value (Caldara-Iacoviello). */
    gprDaily?: number;
    /** GPR moyenne sur 30 jours. */
    gpr30dAvg?: number;
  };
  /** Positions ouvertes du portfolio (pour correlation/concentration). */
  openPositions: Array<{
    symbol: string;
    assetClass: AssetClassKey;
    sector?: string;
    notionalUsd: number;
  }>;
  /**
   * Map de corrélations pré-computées entre candidat et chaque position
   * ouverte. Optionnel — si absent, règle correlation skip (info severity).
   */
  pairwiseCorrelations?: Map<string, number>;
  /** Capital total du portfolio (pour drawdown calc). */
  portfolioCapitalUsd: number;
  /** Session pnl actuel en USD (peut être négatif). */
  sessionPnlUsd: number;
  /** Hourly pnl en USD rolling 60 min. */
  hourlyPnlUsd?: number;
  /** Nombre de SL hits consécutifs récents. */
  consecutiveLosses: number;
  /** Dernier SL hit sur le même symbole — date ISO si récent (< 4h). */
  lastSlOnSameTickerAt?: string;
  /** Beta vs SPY composite du portfolio courant. */
  portfolioBetaSpy?: number;
  /** Optionnel : sigma estimé pour normalisation Z-scores. */
  features?: Record<string, number>;
}

export const SKEPTIC_MODEL_VERSION = 'skeptic-v1.0';

/**
 * Évalue les 6 règles SkepticAgent en parallèle (pure function, no side-effect).
 *
 * @param input Features candidat + macro + portfolio state
 * @param config Configuration des seuils + modes par règle (default = shadow)
 * @returns SkepticVerdict avec composite veto, score, reasons[]
 */
export function evaluateSkeptic(
  input: SkepticInput,
  config: SkepticConfig = DEFAULT_SKEPTIC_CONFIG,
): SkepticVerdict {
  const reasons: SkepticReason[] = [
    checkMicrostructure(input, config.microstructure),
    checkRegimeMacro(input, config.regime_macro),
    checkCorrelation(input, config.correlation),
    checkDrawdown(input, config.drawdown),
    checkLiquidity(input, config.liquidity),
    checkCooldown(input, config.cooldown),
  ];

  // Une règle 'blocking' qui triggered avec severity='block' = vrai veto
  const veto = reasons.some(
    (r) => r.triggered && r.severity === 'block' && r.mode === 'blocking',
  );
  const score = reasons.filter((r) => r.triggered).length / reasons.length;

  const features = buildFeaturesSnapshot(input);

  return {
    veto,
    score: Math.round(score * 100) / 100,
    reasons,
    features,
    modelVersion: SKEPTIC_MODEL_VERSION,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-checks — chaque famille de règle est un pure helper
// ─────────────────────────────────────────────────────────────────────────

function checkMicrostructure(
  input: SkepticInput,
  cfg: SkepticConfig['microstructure'],
): SkepticReason {
  const { candidate } = input;
  const spreadCap = cfg.spreadBpsMax[candidate.assetClass];
  const staleCap = cfg.staleMsMax[candidate.assetClass];

  // Stale quote check (prioritaire — quote stale = no trade)
  if (candidate.quoteAgeMs !== undefined && staleCap !== undefined) {
    if (candidate.quoteAgeMs > staleCap) {
      return {
        rule: 'microstructure',
        triggered: true,
        severity: 'block',
        detail: `stale quote ${candidate.quoteAgeMs}ms > ${staleCap}ms (${candidate.assetClass})`,
        metric: candidate.quoteAgeMs,
        threshold: staleCap,
        mode: cfg.mode,
      };
    }
  }

  // Spread cap check
  if (candidate.spreadBps !== undefined && spreadCap !== undefined) {
    if (candidate.spreadBps > spreadCap) {
      return {
        rule: 'microstructure',
        triggered: true,
        severity: 'block',
        detail: `spread ${candidate.spreadBps}bps > cap ${spreadCap}bps (${candidate.assetClass})`,
        metric: candidate.spreadBps,
        threshold: spreadCap,
        mode: cfg.mode,
      };
    }
  }

  return {
    rule: 'microstructure',
    triggered: false,
    severity: 'info',
    detail: `microstructure OK (spread=${candidate.spreadBps ?? 'n/a'}bps, age=${candidate.quoteAgeMs ?? 'n/a'}ms)`,
    metric: candidate.spreadBps ?? -1,
    threshold: spreadCap ?? -1,
    mode: cfg.mode,
  };
}

function checkRegimeMacro(
  input: SkepticInput,
  cfg: SkepticConfig['regime_macro'],
): SkepticReason {
  const { macro } = input;

  // 1. Macro event blackout window (priorité haute — événement imminent)
  if (
    macro.minutesToHighImpactEvent !== undefined &&
    macro.minutesToHighImpactEvent >= 0 &&
    macro.minutesToHighImpactEvent < cfg.eventBlackoutBeforeMin
  ) {
    return {
      rule: 'regime_macro',
      triggered: true,
      severity: 'block',
      detail: `pre-event blackout: ${macro.minutesToHighImpactEvent}min < ${cfg.eventBlackoutBeforeMin}min before HIGH impact`,
      metric: macro.minutesToHighImpactEvent,
      threshold: cfg.eventBlackoutBeforeMin,
      mode: cfg.mode,
    };
  }
  if (
    macro.minutesSinceHighImpactEvent !== undefined &&
    macro.minutesSinceHighImpactEvent >= 0 &&
    macro.minutesSinceHighImpactEvent < cfg.eventBlackoutAfterMin
  ) {
    return {
      rule: 'regime_macro',
      triggered: true,
      severity: 'block',
      detail: `post-event blackout: ${macro.minutesSinceHighImpactEvent}min < ${cfg.eventBlackoutAfterMin}min after HIGH impact`,
      metric: macro.minutesSinceHighImpactEvent,
      threshold: cfg.eventBlackoutAfterMin,
      mode: cfg.mode,
    };
  }

  // 2. VIX hard cap
  if (macro.vix !== undefined && macro.vix > cfg.vixHard) {
    return {
      rule: 'regime_macro',
      triggered: true,
      severity: 'block',
      detail: `VIX ${macro.vix.toFixed(1)} > hard cap ${cfg.vixHard}`,
      metric: macro.vix,
      threshold: cfg.vixHard,
      mode: cfg.mode,
    };
  }

  // 3. VIX soft + spike confirmation
  if (
    macro.vix !== undefined &&
    macro.vix > cfg.vixSoft &&
    macro.vixPct1d !== undefined &&
    macro.vixPct1d > cfg.vixSpikePct1d
  ) {
    return {
      rule: 'regime_macro',
      triggered: true,
      severity: 'block',
      detail: `VIX ${macro.vix.toFixed(1)} > soft ${cfg.vixSoft} + spike ${(macro.vixPct1d * 100).toFixed(0)}% > ${(cfg.vixSpikePct1d * 100).toFixed(0)}%`,
      metric: macro.vix,
      threshold: cfg.vixSoft,
      mode: cfg.mode,
    };
  }

  // 4. VIX term structure inversion (VIX1M > VIX3M)
  if (
    macro.vix1m !== undefined &&
    macro.vix3m !== undefined &&
    macro.vix1m > macro.vix3m &&
    macro.vix !== undefined &&
    macro.vix > 20
  ) {
    return {
      rule: 'regime_macro',
      triggered: true,
      severity: 'warn',
      detail: `VIX term inversion ${macro.vix1m.toFixed(1)} > ${macro.vix3m.toFixed(1)} (3M)`,
      metric: macro.vix1m,
      threshold: macro.vix3m,
      mode: cfg.mode,
    };
  }

  // 5. VVIX/VIX divergence (fear of fear)
  if (
    macro.vvix !== undefined &&
    macro.vix !== undefined &&
    macro.vix > 0 &&
    macro.vvix / macro.vix > cfg.vvixVixRatioDivergence
  ) {
    return {
      rule: 'regime_macro',
      triggered: true,
      severity: 'warn',
      detail: `VVIX/VIX divergence: ratio ${(macro.vvix / macro.vix).toFixed(1)} > ${cfg.vvixVixRatioDivergence}`,
      metric: macro.vvix / macro.vix,
      threshold: cfg.vvixVixRatioDivergence,
      mode: cfg.mode,
    };
  }

  // 6. HY OAS stress level
  if (macro.hyOasBps !== undefined && macro.hyOasBps > cfg.hyOasStress) {
    return {
      rule: 'regime_macro',
      triggered: true,
      severity: 'block',
      detail: `HY OAS ${macro.hyOasBps}bps > stress ${cfg.hyOasStress}bps (credit risk)`,
      metric: macro.hyOasBps,
      threshold: cfg.hyOasStress,
      mode: cfg.mode,
    };
  }

  // 7. HY OAS widening velocity (+50bp en 5j)
  if (
    macro.hyOas5dDeltaBps !== undefined &&
    macro.hyOas5dDeltaBps > cfg.hyOas5dDeltaBpsAlert
  ) {
    return {
      rule: 'regime_macro',
      triggered: true,
      severity: 'warn',
      detail: `HY OAS widening ${macro.hyOas5dDeltaBps}bps/5d > ${cfg.hyOas5dDeltaBpsAlert}bps (leading)`,
      metric: macro.hyOas5dDeltaBps,
      threshold: cfg.hyOas5dDeltaBpsAlert,
      mode: cfg.mode,
    };
  }

  // 8. DXY + VIX co-spike 2σ (risk-off coordonné)
  if (
    macro.dxyZscore20d !== undefined &&
    macro.vixZscore20d !== undefined &&
    macro.dxyZscore20d > cfg.dxyVixZscoreCoSpike &&
    macro.vixZscore20d > cfg.dxyVixZscoreCoSpike
  ) {
    return {
      rule: 'regime_macro',
      triggered: true,
      severity: 'block',
      detail: `DXY+VIX co-spike >${cfg.dxyVixZscoreCoSpike}σ (z_dxy=${macro.dxyZscore20d.toFixed(2)} z_vix=${macro.vixZscore20d.toFixed(2)})`,
      metric: Math.min(macro.dxyZscore20d, macro.vixZscore20d),
      threshold: cfg.dxyVixZscoreCoSpike,
      mode: cfg.mode,
    };
  }

  // 9. GPR Caldara-Iacoviello spike géopolitique
  if (
    macro.gprDaily !== undefined &&
    macro.gpr30dAvg !== undefined &&
    macro.gpr30dAvg > 0 &&
    macro.gprDaily > 2 * macro.gpr30dAvg
  ) {
    return {
      rule: 'regime_macro',
      triggered: true,
      severity: 'warn',
      detail: `GPR spike ${macro.gprDaily.toFixed(0)} > 2×30d_avg ${macro.gpr30dAvg.toFixed(0)} (geopolitical)`,
      metric: macro.gprDaily,
      threshold: 2 * macro.gpr30dAvg,
      mode: cfg.mode,
    };
  }

  return {
    rule: 'regime_macro',
    triggered: false,
    severity: 'info',
    detail: `regime OK (vix=${macro.vix ?? 'n/a'} hy_oas=${macro.hyOasBps ?? 'n/a'}bps)`,
    metric: macro.vix ?? -1,
    threshold: cfg.vixSoft,
    mode: cfg.mode,
  };
}

function checkCorrelation(
  input: SkepticInput,
  cfg: SkepticConfig['correlation'],
): SkepticReason {
  if (input.openPositions.length === 0) {
    return {
      rule: 'correlation',
      triggered: false,
      severity: 'info',
      detail: 'no open positions — correlation skipped',
      metric: 0,
      threshold: cfg.pairwiseMax,
      mode: cfg.mode,
    };
  }

  // 1. Pairwise correlation max (si fournie)
  if (input.pairwiseCorrelations && input.pairwiseCorrelations.size > 0) {
    const corrs = Array.from(input.pairwiseCorrelations.values()).map(Math.abs);
    const maxRho = Math.max(...corrs);
    if (maxRho >= cfg.pairwiseMax) {
      return {
        rule: 'correlation',
        triggered: true,
        severity: 'block',
        detail: `|ρ_max|=${maxRho.toFixed(2)} ≥ ${cfg.pairwiseMax} (same risk unit)`,
        metric: maxRho,
        threshold: cfg.pairwiseMax,
        mode: cfg.mode,
      };
    }
    if (maxRho >= cfg.pairwiseCluster && input.openPositions.length >= cfg.minOpensForAvg) {
      const avgRho = corrs.reduce((s, c) => s + c, 0) / corrs.length;
      if (avgRho > cfg.avgClusterMin) {
        return {
          rule: 'correlation',
          triggered: true,
          severity: 'block',
          detail: `avg ρ_open=${avgRho.toFixed(2)} > ${cfg.avgClusterMin} avec ${input.openPositions.length} opens (cluster)`,
          metric: avgRho,
          threshold: cfg.avgClusterMin,
          mode: cfg.mode,
        };
      }
    }
  }

  // 2. Asset class concentration cap
  const sameClass = input.openPositions.filter(
    (p) => p.assetClass === input.candidate.assetClass,
  );
  const sameClassNotional = sameClass.reduce((s, p) => s + p.notionalUsd, 0);
  const totalNotional =
    input.openPositions.reduce((s, p) => s + p.notionalUsd, 0) +
    input.candidate.notionalUsd;
  if (totalNotional > 0) {
    const newClassPct =
      (sameClassNotional + input.candidate.notionalUsd) / totalNotional;
    if (newClassPct > cfg.assetClassCapPct) {
      return {
        rule: 'correlation',
        triggered: true,
        severity: 'block',
        detail: `asset_class ${input.candidate.assetClass} concentration ${(newClassPct * 100).toFixed(0)}% > cap ${(cfg.assetClassCapPct * 100).toFixed(0)}%`,
        metric: newClassPct,
        threshold: cfg.assetClassCapPct,
        mode: cfg.mode,
      };
    }
  }

  // 3. Sector concentration cap (si sector fourni)
  if (input.candidate.sector) {
    const sameSector = input.openPositions.filter(
      (p) => p.sector === input.candidate.sector,
    );
    const sameSectorNotional = sameSector.reduce((s, p) => s + p.notionalUsd, 0);
    if (totalNotional > 0) {
      const newSectorPct =
        (sameSectorNotional + input.candidate.notionalUsd) / totalNotional;
      if (newSectorPct > cfg.sectorCapPct) {
        return {
          rule: 'correlation',
          triggered: true,
          severity: 'block',
          detail: `sector ${input.candidate.sector} concentration ${(newSectorPct * 100).toFixed(0)}% > cap ${(cfg.sectorCapPct * 100).toFixed(0)}%`,
          metric: newSectorPct,
          threshold: cfg.sectorCapPct,
          mode: cfg.mode,
        };
      }
    }
  }

  // 4. Portfolio beta cap (si fourni)
  if (
    input.portfolioBetaSpy !== undefined &&
    input.portfolioBetaSpy > cfg.betaSpyCap
  ) {
    return {
      rule: 'correlation',
      triggered: true,
      severity: 'warn',
      detail: `portfolio beta_SPY=${input.portfolioBetaSpy.toFixed(2)} > cap ${cfg.betaSpyCap}`,
      metric: input.portfolioBetaSpy,
      threshold: cfg.betaSpyCap,
      mode: cfg.mode,
    };
  }

  return {
    rule: 'correlation',
    triggered: false,
    severity: 'info',
    detail: `correlation OK (${input.openPositions.length} opens, max_ρ=${input.pairwiseCorrelations ? 'computed' : 'n/a'})`,
    metric: 0,
    threshold: cfg.pairwiseMax,
    mode: cfg.mode,
  };
}

function checkDrawdown(
  input: SkepticInput,
  cfg: SkepticConfig['drawdown'],
): SkepticReason {
  if (input.portfolioCapitalUsd <= 0) {
    return {
      rule: 'drawdown',
      triggered: false,
      severity: 'info',
      detail: 'no capital — drawdown skipped',
      metric: 0,
      threshold: cfg.dailyDdHardKill,
      mode: cfg.mode,
    };
  }

  const dailyPnlPct = input.sessionPnlUsd / input.portfolioCapitalUsd;

  // 1. Hard kill — daily DD
  if (dailyPnlPct <= cfg.dailyDdHardKill) {
    return {
      rule: 'drawdown',
      triggered: true,
      severity: 'block',
      detail: `daily DD ${(dailyPnlPct * 100).toFixed(2)}% ≤ kill ${(cfg.dailyDdHardKill * 100).toFixed(2)}% (FTMO-style)`,
      metric: dailyPnlPct,
      threshold: cfg.dailyDdHardKill,
      mode: cfg.mode,
    };
  }

  // 2. Hourly DD soft warn
  if (input.hourlyPnlUsd !== undefined) {
    const hourlyPct = input.hourlyPnlUsd / input.portfolioCapitalUsd;
    if (hourlyPct <= cfg.hourlyDdSoftWarn) {
      return {
        rule: 'drawdown',
        triggered: true,
        severity: 'block',
        detail: `hourly DD ${(hourlyPct * 100).toFixed(2)}% ≤ ${(cfg.hourlyDdSoftWarn * 100).toFixed(2)}%`,
        metric: hourlyPct,
        threshold: cfg.hourlyDdSoftWarn,
        mode: cfg.mode,
      };
    }
  }

  // 3. Consecutive losses kill
  if (input.consecutiveLosses >= cfg.consecutiveLossesKill) {
    return {
      rule: 'drawdown',
      triggered: true,
      severity: 'block',
      detail: `${input.consecutiveLosses} consec SL ≥ kill ${cfg.consecutiveLossesKill} (anti-tilt fort)`,
      metric: input.consecutiveLosses,
      threshold: cfg.consecutiveLossesKill,
      mode: cfg.mode,
    };
  }

  // 4. Consecutive losses pause
  if (input.consecutiveLosses >= cfg.consecutiveLossesPause) {
    return {
      rule: 'drawdown',
      triggered: true,
      severity: 'warn',
      detail: `${input.consecutiveLosses} consec SL ≥ pause ${cfg.consecutiveLossesPause} (Three-Loss Rule)`,
      metric: input.consecutiveLosses,
      threshold: cfg.consecutiveLossesPause,
      mode: cfg.mode,
    };
  }

  // 5. Soft warn daily DD
  if (dailyPnlPct <= cfg.dailyDdSoftWarn) {
    return {
      rule: 'drawdown',
      triggered: true,
      severity: 'warn',
      detail: `daily DD ${(dailyPnlPct * 100).toFixed(2)}% ≤ soft ${(cfg.dailyDdSoftWarn * 100).toFixed(2)}% (quarter-Kelly sizing recommended)`,
      metric: dailyPnlPct,
      threshold: cfg.dailyDdSoftWarn,
      mode: cfg.mode,
    };
  }

  return {
    rule: 'drawdown',
    triggered: false,
    severity: 'info',
    detail: `drawdown OK (daily=${(dailyPnlPct * 100).toFixed(2)}% consec_sl=${input.consecutiveLosses})`,
    metric: dailyPnlPct,
    threshold: cfg.dailyDdSoftWarn,
    mode: cfg.mode,
  };
}

function checkLiquidity(
  input: SkepticInput,
  cfg: SkepticConfig['liquidity'],
): SkepticReason {
  const { candidate } = input;

  // 1. avgVol50d min par classe
  const minVol = cfg.minAvgVol50d[candidate.assetClass];
  if (
    minVol !== undefined &&
    minVol > 0 &&
    candidate.avgVol50d < minVol
  ) {
    return {
      rule: 'liquidity',
      triggered: true,
      severity: 'block',
      detail: `avgVol50d ${(candidate.avgVol50d / 1000).toFixed(0)}k < min ${(minVol / 1000).toFixed(0)}k (${candidate.assetClass})`,
      metric: candidate.avgVol50d,
      threshold: minVol,
      mode: cfg.mode,
    };
  }

  // 2. ADV participation cap (notional / (avgVol50d * close))
  const advUsd = candidate.avgVol50d * candidate.close;
  if (advUsd > 0) {
    const participation = candidate.notionalUsd / advUsd;
    const isLarge = candidate.assetClass === 'us_equity_large';
    const cap = isLarge ? cfg.advPctMaxLarge : cfg.advPctMaxSmall;
    if (participation > cap) {
      return {
        rule: 'liquidity',
        triggered: true,
        severity: 'block',
        detail: `ADV participation ${(participation * 100).toFixed(2)}% > cap ${(cap * 100).toFixed(2)}% (${candidate.assetClass})`,
        metric: participation,
        threshold: cap,
        mode: cfg.mode,
      };
    }
  }

  return {
    rule: 'liquidity',
    triggered: false,
    severity: 'info',
    detail: `liquidity OK (avgVol50d=${(candidate.avgVol50d / 1000).toFixed(0)}k)`,
    metric: candidate.avgVol50d,
    threshold: minVol ?? 0,
    mode: cfg.mode,
  };
}

function checkCooldown(
  input: SkepticInput,
  cfg: SkepticConfig['cooldown'],
): SkepticReason {
  if (!input.lastSlOnSameTickerAt) {
    return {
      rule: 'cooldown',
      triggered: false,
      severity: 'info',
      detail: 'no recent SL on same ticker',
      metric: 0,
      threshold: cfg.revengeCooldownMinSameTicker,
      mode: cfg.mode,
    };
  }

  const elapsedMs = Date.now() - new Date(input.lastSlOnSameTickerAt).getTime();
  const elapsedMin = elapsedMs / 60_000;
  if (elapsedMin < cfg.revengeCooldownMinSameTicker) {
    return {
      rule: 'cooldown',
      triggered: true,
      severity: 'block',
      detail: `anti-revenge: SL ${elapsedMin.toFixed(0)}min ago < ${cfg.revengeCooldownMinSameTicker}min cooldown on ${input.candidate.symbol}`,
      metric: elapsedMin,
      threshold: cfg.revengeCooldownMinSameTicker,
      mode: cfg.mode,
    };
  }

  return {
    rule: 'cooldown',
    triggered: false,
    severity: 'info',
    detail: `cooldown OK (${elapsedMin.toFixed(0)}min since last SL on ${input.candidate.symbol})`,
    metric: elapsedMin,
    threshold: cfg.revengeCooldownMinSameTicker,
    mode: cfg.mode,
  };
}

function buildFeaturesSnapshot(input: SkepticInput): Record<string, number> {
  const f: Record<string, number> = {};
  if (input.macro.vix !== undefined) f['vix'] = input.macro.vix;
  if (input.macro.hyOasBps !== undefined) f['hy_oas_bps'] = input.macro.hyOasBps;
  if (input.macro.dxyZscore20d !== undefined) f['dxy_zscore_20d'] = input.macro.dxyZscore20d;
  if (input.candidate.spreadBps !== undefined) f['spread_bps'] = input.candidate.spreadBps;
  if (input.candidate.quoteAgeMs !== undefined) f['quote_age_ms'] = input.candidate.quoteAgeMs;
  f['notional_usd'] = input.candidate.notionalUsd;
  f['avg_vol_50d'] = input.candidate.avgVol50d;
  if (input.portfolioCapitalUsd > 0) {
    f['session_pnl_pct'] = input.sessionPnlUsd / input.portfolioCapitalUsd;
  }
  f['consecutive_losses'] = input.consecutiveLosses;
  f['n_open_positions'] = input.openPositions.length;
  return f;
}
