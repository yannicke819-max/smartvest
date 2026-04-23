/**
 * Lisa — Multi-Asset AI Analyst Types
 *
 * Langage unifié cross-asset : une action, un future, un swap, une crypto,
 * un produit structuré peuvent tous être décrits dans les mêmes structures.
 * C'est la base du ''risk lens unique'' de Lisa.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Classes d'actifs (le plus large possible, extensible)
// ─────────────────────────────────────────────────────────────────────────────
export const AssetClass = z.enum([
  // Actions
  'equity_us_large', 'equity_us_small', 'equity_eu', 'equity_em', 'equity_jp', 'equity_cn',
  // Obligations
  'govt_bonds_us', 'govt_bonds_eu', 'govt_bonds_em',
  'credit_ig', 'credit_hy', 'credit_em', 'credit_private',
  // FX
  'fx_g10', 'fx_em', 'fx_exotic',
  // Commodities
  'commodities_energy', 'commodities_metals_precious', 'commodities_metals_industrial',
  'commodities_agri',
  // Crypto
  'crypto_bitcoin', 'crypto_ethereum', 'crypto_altcoins', 'crypto_stablecoin',
  // Dérivés
  'derivatives_options', 'derivatives_futures', 'derivatives_swaps',
  'derivatives_vol',
  'structured_products',
  // Autres
  'real_estate', 'alt_hedge_funds', 'cash',
]);
export type AssetClass = z.infer<typeof AssetClass>;

// ─────────────────────────────────────────────────────────────────────────────
// Régime de marché — l'état global vu par Lisa
// ─────────────────────────────────────────────────────────────────────────────
export const MarketRegime = z.enum([
  'risk_on_reflation',
  'risk_on_goldilocks',
  'risk_off_flight_to_quality',
  'risk_off_liquidity_crunch',
  'stagflation',
  'deflationary_shock',
  'late_cycle_peak',
  'early_cycle_recovery',
  'mid_cycle_expansion',
  'policy_pivot_dovish',
  'policy_pivot_hawkish',
  'geopolitical_stress',
  'tech_bubble_euphoria',
  'fragmented_no_consensus',
]);
export type MarketRegime = z.infer<typeof MarketRegime>;

// ─────────────────────────────────────────────────────────────────────────────
// Thèse Lisa — le cœur du raisonnement agnostic cross-asset
// ─────────────────────────────────────────────────────────────────────────────
export const ThesisCategory = z.enum([
  'hidden_gem',       // pépite cachée, sous-couverte
  'turnaround',       // retournement fondamental
  'flow_timing',      // opportunité de flux / microstructure
  'watchlist',        // pas encore mûre, à surveiller
  'contrarian',       // consensus erroné identifié
  'mean_reversion',   // anomalie statistique corrigeable
  'event_driven',     // catalyseur spécifique (earnings, merger, news)
]);
export type ThesisCategory = z.infer<typeof ThesisCategory>;

/**
 * Expression = façon concrète de jouer une thèse.
 * Plusieurs expressions possibles pour la même thèse (equity vs derivative vs credit).
 */
export const AssetExpression = z.object({
  /** Identifiant instrument (ticker, ISIN, symbol crypto, etc.) */
  symbol: z.string().min(1),
  /** Nom humain */
  name: z.string().min(1),
  /** Classe d'actifs pour le risk lens */
  assetClass: AssetClass,
  /** Venue d'exécution préférée (selon broker trust, liquidité) */
  preferredVenue: z.string().min(1),
  /** Direction : long, short, neutral (spread/pair), optionnalité */
  direction: z.enum(['long', 'short', 'long_call', 'long_put', 'short_call', 'short_put', 'pair_spread']),
  /** Quantité ou notionnel — en unités natives ou % du portefeuille */
  sizingMethod: z.enum(['fixed_notional', 'pct_portfolio', 'kelly_fraction', 'risk_parity', 'vol_targeting']),
  sizingValue: z.string(),  // Decimal as string
  /** Coût d'exécution estimé en bps (commission + spread + slippage + FX markup) */
  estimatedCostBps: z.number().int().min(0),
  /** Liquidité quotidienne moyenne en USD */
  averageDailyVolumeUsd: z.string().nullable(),
  /** Rationale bref pour cette expression vs les autres */
  whyThisExpression: z.string(),
});
export type AssetExpression = z.infer<typeof AssetExpression>;

export const ThesisRiskReward = z.object({
  /** Scénario central : fourchette de performance attendue sur horizon */
  centralScenarioReturnPct: z.object({
    low: z.number(),
    mid: z.number(),
    high: z.number(),
  }),
  /** Scénario adverse (stress case) */
  adverseScenarioReturnPct: z.number(),
  /** Ratio approximatif (upside / downside potential) */
  riskRewardRatio: z.number(),
  /** Horizon estimé avant matérialisation thèse */
  horizonDays: z.number().int().positive(),
  /** Sources de convexité */
  convexitySources: z.array(z.string()),
});
export type ThesisRiskReward = z.infer<typeof ThesisRiskReward>;

export const ThesisInvalidation = z.object({
  /** Conditions quantifiées qui rendent la thèse caduque */
  conditions: z.array(z.object({
    description: z.string(),
    metricType: z.enum(['price', 'yield', 'spread', 'vix', 'ratio', 'event', 'time']),
    thresholdValue: z.string().nullable(),
    thresholdDirection: z.enum(['above', 'below', 'cross', 'occurs']).nullable(),
  })),
  /** Conditions d'échec simples non quantifiables */
  qualitativeConditions: z.array(z.string()),
});
export type ThesisInvalidation = z.infer<typeof ThesisInvalidation>;

export const AntiBullshitCheck = z.object({
  /** Thèse crowdée ou consensus déjà établi ? */
  isCrowded: z.boolean(),
  isCrowdedRationale: z.string(),
  /** Driver fondamental, flux, ou narratif ? */
  driverType: z.enum(['fundamentals_cashflow', 'fundamentals_spreads', 'flows_positioning', 'pure_narrative', 'mixed']),
  /** Basé sur quantifiable data ou story ? */
  evidenceType: z.enum(['hard_data', 'soft_data', 'qualitative', 'speculative']),
  /** Notes de l'agent sur les faiblesses auto-détectées */
  selfCritique: z.string(),
});
export type AntiBullshitCheck = z.infer<typeof AntiBullshitCheck>;

/**
 * Thèse Lisa complète.
 * Structure identique pour toute idée, toute classe d'actifs.
 */
export const LisaThesis = z.object({
  id: z.string().uuid(),
  /** Nom court lisible humain */
  title: z.string().min(1).max(200),
  /** Résumé 5-10 lignes */
  summary: z.string(),
  /** Catalyseur principal (micro/macro/flow/technique/événement) */
  catalyst: z.string(),
  /** Qui est probablement du mauvais côté du trade */
  whoIsWrong: z.string(),
  /** Classification */
  category: ThesisCategory,
  /** Expressions candidates (plusieurs classes d'actifs possibles) */
  expressions: z.array(AssetExpression).min(1),
  /** Expression préférée parmi les candidates */
  preferredExpressionIndex: z.number().int().min(0),
  /** Pourquoi cette expression vs les autres */
  expressionChoiceRationale: z.string(),
  /** Asymétrie risque/gain */
  riskReward: ThesisRiskReward,
  /** Invalidation conditions */
  invalidation: ThesisInvalidation,
  /** Anti-bullshit self-check */
  antiBullshit: AntiBullshitCheck,
  /** Historical analogs consultés (slugs du corpus) */
  analogSlugs: z.array(z.string()),
  /** Confidence globale 0-100 */
  confidenceScore: z.number().int().min(0).max(100),
  /** Timestamp de génération */
  generatedAt: z.string().datetime(),
  /** Modèle Claude utilisé + tokens input/output */
  claudeMeta: z.object({
    model: z.string(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    cachedTokens: z.number().int().optional(),
  }),
});
export type LisaThesis = z.infer<typeof LisaThesis>;

// ─────────────────────────────────────────────────────────────────────────────
// Risk Lens Unifié — comment Lisa évalue n'importe quelle position
// ─────────────────────────────────────────────────────────────────────────────
export const UnifiedRiskLens = z.object({
  /** Volatilité annualisée estimée en % */
  annualizedVolatilityPct: z.number().min(0),
  /** VaR 1-day 95% en % du notionnel */
  var95_1day_pct: z.number().min(0),
  /** Expected Shortfall 1-day 95% */
  expectedShortfall95_1day_pct: z.number().min(0),
  /** Max drawdown historique sur horizon comparable */
  historicalMaxDrawdownPct: z.number().min(0),
  /** Liquidité : jours pour sortir 50% de la position en mid-spread */
  daysToExit50pct: z.number().min(0),
  /** Corrélations avec les principales asset classes (-1 à +1) */
  correlationsToMajorAssets: z.record(z.string(), z.number().min(-1).max(1)),
  /** Levier effectif (notionnel / capital) */
  effectiveLeverage: z.number().min(0),
  /** Beta vs marché principal de référence */
  beta: z.number(),
  /** Sensibilité aux régimes identifiés */
  regimeSensitivity: z.record(z.string(), z.enum(['positive', 'negative', 'neutral'])),
});
export type UnifiedRiskLens = z.infer<typeof UnifiedRiskLens>;

// ─────────────────────────────────────────────────────────────────────────────
// Contraintes risque — HARD LIMITS que Lisa ne peut PAS violer
// ─────────────────────────────────────────────────────────────────────────────
export const RiskConstraints = z.object({
  /** Drawdown max acceptable 2 jours (HARD KILL si dépassé) */
  maxDrawdown2DaysPct: z.number().min(0).default(10.0),
  /** Drawdown max acceptable 1 semaine */
  maxDrawdown7DaysPct: z.number().min(0).default(15.0),
  /** Drawdown max acceptable 30 jours */
  maxDrawdown30DaysPct: z.number().min(0).default(25.0),
  /** Taille max d'une position unique en % capital */
  maxPositionSizePct: z.number().min(0).max(100).default(25.0),
  /** Nombre max de positions simultanées */
  maxOpenPositions: z.number().int().min(1).default(10),
  /** Levier effectif max */
  maxLeverage: z.number().min(1).default(1.5),
  /** Exposition max par classe d'actifs */
  maxExposurePerAssetClassPct: z.number().min(0).max(100).default(40.0),
  /** Volatilité portefeuille annualisée max */
  maxPortfolioVolatilityPct: z.number().min(0).default(20.0),
  /** % capital cible à déployer (le reste = cash reserve). Soft target,
   *  Claude vise ce niveau d'exposition lors de la génération. */
  targetDeploymentPct: z.number().min(0).max(100).default(60.0),
  /** Si true, auto-liquidate all si drawdown 2d > maxDrawdown2DaysPct */
  autoLiquidateOnKill: z.boolean().default(true),
});
export type RiskConstraints = z.infer<typeof RiskConstraints>;

// ─────────────────────────────────────────────────────────────────────────────
// Proposition d'allocation — ce que Lisa produit au user
// ─────────────────────────────────────────────────────────────────────────────
export const AllocationProposal = z.object({
  id: z.string().uuid(),
  /** Capital disponible au moment de la proposition */
  capitalUsd: z.string(),  // decimal
  /** Devise de base */
  baseCurrency: z.string().length(3),
  /** Régime de marché identifié au moment de la proposition */
  detectedRegime: MarketRegime,
  /**
   * Momentum directionnel détecté sur le cycle courant.
   * Gouverne les garde-fous dynamiques (cap d'ouvertures / cooldown) :
   *   - bullish_strong → cap relâché, cooldown bypass (réactivité max)
   *   - neutral        → cap + cooldown par défaut
   *   - bearish        → cap serré, cooldown rallongé (protection)
   * Claude doit justifier ce flag dans `warnings` quand il est non-neutral.
   */
  marketMomentum: z.enum(['bullish_strong', 'neutral', 'bearish']).default('neutral'),
  /** Synthèse du régime en texte */
  regimeSummary: z.string(),
  /** Poches favorisées (3 max) */
  favoredPockets: z.array(z.object({
    assetClass: AssetClass,
    rationale: z.string(),
  })),
  /** Poches évitées (3 max) */
  avoidedPockets: z.array(z.object({
    assetClass: AssetClass,
    rationale: z.string(),
  })),
  /** Thèses proposées (3-7 max) */
  theses: z.array(LisaThesis).min(1).max(7),
  /** Allocation suggérée par thèse (somme <= 100%) */
  allocations: z.array(z.object({
    thesisId: z.string().uuid(),
    pctCapital: z.number().min(0).max(100),
    amountUsd: z.string(),  // decimal
  })),
  /** Cash restant en % */
  cashReservePct: z.number().min(0).max(100),
  /** Risk lens du portefeuille agrégé */
  portfolioRiskLens: UnifiedRiskLens,
  /** Contraintes risque appliquées */
  constraints: RiskConstraints,
  /** Warnings Lisa s'auto-identifie */
  warnings: z.array(z.string()),
  /** Timestamp */
  generatedAt: z.string().datetime(),
  /** Statut de validation (user approval en mode MANUAL_EXPLICIT) */
  status: z.enum(['draft', 'proposed', 'approved', 'rejected', 'executed', 'expired']),
});
export type AllocationProposal = z.infer<typeof AllocationProposal>;

// ─────────────────────────────────────────────────────────────────────────────
// Portfolio Trajectory Optimizer (Lisa v2)
// ─────────────────────────────────────────────────────────────────────────────

/** Statut d'avancement vs la trajectoire cible sur performance_horizon_days. */
export type TrajectoryStatus = 'EN_AVANCE' | 'DANS_LE_PLAN' | 'EN_RETARD' | 'HORS_TRAJECTOIRE';

/** Séquence récente de positions fermées dans le même sens (gain ou perte). */
export type RecentStreak = { kind: 'wins' | 'losses'; count: number } | null;

/** Ventilation des coûts journaliers moyens sur 7 j. */
export interface CostBreakdown {
  claudeUsd: number;
  eodhdUsd: number;
  tradingFrictionsUsd: number;
}

/** Métriques historiques calculées à la volée avant chaque cycle Lisa. */
export interface HistoryMetrics {
  netReturnFromInceptionPct: number | null;
  netReturn7dPct: number | null;
  netReturn30dPct: number | null;
  drawdownFromPeakPct: number | null;
  realizedVolatility7dPct: number | null;
  winRatePct: number | null;
  closedPositionsCount: number;
  recentStreak: RecentStreak;
  avgDailyCostUsd7d: number | null;
  costBreakdown: CostBreakdown;
}

/** Objectifs de performance nets de coûts (tous optionnels). */
export interface PerformanceObjectives {
  returnTargetDailyPct: number | null;
  returnTargetMonthlyPct: number | null;
  returnTargetAnnualPct: number | null;
  dailyCostBudgetUsd: number | null;
  performanceHorizonDays: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision Log — traçabilité de CHAQUE action Lisa
// ─────────────────────────────────────────────────────────────────────────────
export const DecisionLogEntryKind = z.enum([
  'proposal_generated',
  'proposal_approved',
  'proposal_rejected',
  'position_opened',
  'position_closed',
  'position_resized',
  'thesis_invalidated',
  'risk_limit_breached',
  'kill_switch_triggered',
  'autopilot_cycle_started',
  'autopilot_cycle_completed',
  'market_regime_changed',
  'analog_matched',
  'user_override',
]);
export type DecisionLogEntryKind = z.infer<typeof DecisionLogEntryKind>;

export const DecisionLogEntry = z.object({
  id: z.string().uuid(),
  portfolioId: z.string().uuid(),
  kind: DecisionLogEntryKind,
  /** Titre lisible court */
  summary: z.string(),
  /** Rationale complet */
  rationale: z.string(),
  /** Données structurées associées (thesis ID, position ID, metrics…) */
  payload: z.record(z.unknown()),
  /** Hash cryptographique chaîné (audit immuable) */
  hashChainPrev: z.string().nullable(),
  hashChainCurrent: z.string(),
  /** Qui a déclenché : user_manual, autopilot, risk_monitor, corpus_trigger */
  triggeredBy: z.enum(['user_manual', 'autopilot_cron', 'risk_monitor', 'corpus_trigger', 'market_event']),
  timestamp: z.string().datetime(),
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntry>;

// ─────────────────────────────────────────────────────────────────────────────
// Session flags — pour spécialiser Lisa par profil
// ─────────────────────────────────────────────────────────────────────────────
export const SessionProfile = z.enum([
  'long_term_investor',   // horizon > 6 mois, low turnover
  'active_trading',       // swing, horizon 1-30 jours
  'sniper_mode',          // entrée/sortie < 1 jour, opportunity-driven
  'hyper_active',         // high-frequency analysis, continuous rebalance
]);
export type SessionProfile = z.infer<typeof SessionProfile>;

export const LisaSessionConfig = z.object({
  profile: SessionProfile,
  /** Capital disponible */
  capitalUsd: z.string(),
  baseCurrency: z.string().length(3).default('EUR'),
  /** Constraints custom */
  riskConstraints: RiskConstraints,
  /** Filtres univers */
  includeAssetClasses: z.array(AssetClass).optional(),
  excludeAssetClasses: z.array(AssetClass).optional(),
  /** Anti-consensus strength 0-10 (10 = max contrarian) */
  antiConsensusStrength: z.number().int().min(0).max(10).default(7),
  /** Max thèses à proposer */
  maxTheses: z.number().int().min(1).max(7).default(5),
  /** Activer les marchés spécifiques */
  enableCrypto: z.boolean().default(true),
  enableDerivatives: z.boolean().default(false),
  enableLeverage: z.boolean().default(false),
});
export type LisaSessionConfig = z.infer<typeof LisaSessionConfig>;
