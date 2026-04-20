import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';

export const SignalCategory = z.enum([
  'central_bank_decision',
  'inflation_data',
  'growth_data',
  'employment_data',
  'fx_move',
  'commodity_move',
  'geopolitical_tension',
  'election_event',
  'regulatory_change',
  'market_stress',
  'earnings_surprise',
  'credit_event',
]);
export type SignalCategory = z.infer<typeof SignalCategory>;

export const SignalSeverity = z.enum(['info', 'watch', 'warning', 'critical', 'systemic']);
export type SignalSeverity = z.infer<typeof SignalSeverity>;

export const SignalConfidence = z.enum(['low', 'medium', 'high']);
export type SignalConfidence = z.infer<typeof SignalConfidence>;

export const ImpactHorizon = z.enum(['immediate', 'short_term', 'medium_term', 'long_term']);
export type ImpactHorizon = z.infer<typeof ImpactHorizon>;

export const SignalStatus = z.enum(['ingested', 'assessed', 'concluded', 'archived', 'dismissed']);
export type SignalStatus = z.infer<typeof SignalStatus>;

export const SignalSource = z.object({
  kind: z.enum(['manual', 'rss', 'webhook', 'api', 'user_input']),
  name: z.string(),
  url: z.string().nullable(),
  reliabilityScore: z.number().min(0).max(1).nullable(),
});
export type SignalSource = z.infer<typeof SignalSource>;

export const MacroSignal = z.object({
  id: Uuid,
  category: SignalCategory,
  status: SignalStatus,

  title: z.string().min(1).max(500),
  summary: z.string().max(5000),
  rawContent: z.string().nullable(),

  source: SignalSource,

  severity: SignalSeverity,
  confidence: SignalConfidence,
  impactHorizon: ImpactHorizon,

  // Geographic scope
  geographicZones: z.array(z.string()),
  countries: z.array(z.string()),

  // Economic scope
  affectedSectors: z.array(z.string()),
  affectedCurrencies: z.array(z.string()),
  affectedAssetClasses: z.array(z.string()),

  // References and metadata
  references: z.array(z.string()),
  tags: z.array(z.string()),

  occurredAt: z.string().datetime(),
  ingestedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MacroSignal = z.infer<typeof MacroSignal>;

// ── Impact assessment ──────────────────────────────────────────────────────────

export const ExposureDirection = z.enum(['positive', 'negative', 'uncertain', 'neutral']);
export type ExposureDirection = z.infer<typeof ExposureDirection>;

export const AssetExposureLink = z.object({
  assetId: Uuid.nullable(),
  ticker: z.string().nullable(),
  isin: z.string().nullable(),
  direction: ExposureDirection,
  magnitudePct: z.string().nullable(),
  rationale: z.string(),
  confidence: SignalConfidence,
});
export type AssetExposureLink = z.infer<typeof AssetExposureLink>;

export const SectorExposureLink = z.object({
  sector: z.string(),
  direction: ExposureDirection,
  magnitudePct: z.string().nullable(),
  rationale: z.string(),
  affectedAssetClasses: z.array(z.string()),
});
export type SectorExposureLink = z.infer<typeof SectorExposureLink>;

export const PortfolioImpactEstimate = z.object({
  portfolioId: Uuid,
  estimatedImpactPct: z.string().nullable(),
  exposedPositionCount: z.number().int(),
  exposedNotionalPct: z.string().nullable(),
  currency: z.string().length(3),
  aggravatingFactors: z.array(z.string()),
  mitigatingFactors: z.array(z.string()),
  invalidationConditions: z.array(z.string()),
  estimatedAt: z.string().datetime(),
});
export type PortfolioImpactEstimate = z.infer<typeof PortfolioImpactEstimate>;

export const SignalImpactAssessment = z.object({
  id: Uuid,
  signalId: Uuid,
  assetExposures: z.array(AssetExposureLink),
  sectorExposures: z.array(SectorExposureLink),
  portfolioImpacts: z.array(PortfolioImpactEstimate),
  overallSeverity: SignalSeverity,
  overallConfidence: SignalConfidence,
  assessedAt: z.string().datetime(),
  notes: z.string().nullable(),
});
export type SignalImpactAssessment = z.infer<typeof SignalImpactAssessment>;

// ── Historical analogs & RETEX ─────────────────────────────────────────────────

export const AssetClassBehavior = z.object({
  assetClass: z.string(),
  avgReturnPct: z.string(),
  minReturnPct: z.string(),
  maxReturnPct: z.string(),
  medianDurationDays: z.number(),
  dispersionNote: z.string().nullable(),
});
export type AssetClassBehavior = z.infer<typeof AssetClassBehavior>;

export const HistoricalAnalog = z.object({
  id: Uuid,
  signalId: Uuid,
  episodeTitle: z.string(),
  episodeDateStart: z.string(),
  episodeDateEnd: z.string().nullable(),
  contextDescription: z.string(),
  similarityScore: z.number().min(0).max(1),
  keyDrivers: z.array(z.string()),
  resolution: z.string().nullable(),
  assetClassBehaviors: z.array(AssetClassBehavior),
  limitationsOfComparison: z.array(z.string()),
  createdAt: z.string().datetime(),
});
export type HistoricalAnalog = z.infer<typeof HistoricalAnalog>;

export const RetexInsight = z.object({
  id: Uuid,
  signalId: Uuid,
  analogId: Uuid,
  lesson: z.string(),
  applicabilityNote: z.string(),
  observedBehavior: z.string(),
  confidenceLevel: SignalConfidence,
  createdAt: z.string().datetime(),
});
export type RetexInsight = z.infer<typeof RetexInsight>;

// ── Signal conclusion ──────────────────────────────────────────────────────────

export const ConclusionOutputMode = z.enum([
  'information',
  'alert',
  'simulation',
  'suggestion',
  'action_candidate',
]);
export type ConclusionOutputMode = z.infer<typeof ConclusionOutputMode>;

export const SignalConclusion = z.object({
  id: Uuid,
  signalId: Uuid,

  summaryText: z.string(),
  exposedAssets: z.array(z.string()),
  exposedSectors: z.array(z.string()),
  probableScenario: z.string(),
  mainRisk: z.string(),
  counterArguments: z.array(z.string()),

  overallConfidence: SignalConfidence,
  needsReview: z.boolean(),

  outputMode: ConclusionOutputMode,
  proposedActions: z.array(z.string()),

  delegationMode: z.enum(['MANUAL_EXPLICIT', 'HYBRID_SUGGESTIVE', 'AUTONOMOUS_GUARDED']),

  generatedAt: z.string().datetime(),
});
export type SignalConclusion = z.infer<typeof SignalConclusion>;

export const SignalWatchEvent = z.object({
  id: Uuid,
  signalId: Uuid,
  userId: Uuid,
  eventKind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type SignalWatchEvent = z.infer<typeof SignalWatchEvent>;
