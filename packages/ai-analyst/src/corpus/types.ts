/**
 * Corpus Query Service — Types
 *
 * Représentation TypeScript des événements historiques seeded dans
 * historical_events_corpus (DB Supabase).
 */

export interface HistoricalEvent {
  id: string;
  slug: string;
  title: string;
  category: string;
  dateStart: string;
  dateEnd: string | null;
  durationDescription: string | null;
  contextDescription: string;
  keyDrivers: string[];
  preconditions: string[];
  marketImpactByAssetClass: Record<string, Record<string, unknown>>;
  regimeShift: Record<string, unknown> | null;
  resolution: string | null;
  lessonsLearned: string[];
  limitationsOfComparison: string[];
  similarSetupsTags: string[];
  severityAtPeak: 'info' | 'watch' | 'warning' | 'critical' | 'systemic';
  dataQuality: 'excellent' | 'good' | 'partial' | 'reconstructed';
  references: Array<Record<string, unknown>>;
}

export interface CorpusQueryFilters {
  /** Tags à matcher (OR logic — au moins un match) */
  tags?: string[];
  /** Catégories à matcher */
  categories?: string[];
  /** Sévérité minimum */
  minSeverity?: 'info' | 'watch' | 'warning' | 'critical' | 'systemic';
  /** Limite nombre de résultats */
  limit?: number;
}

/**
 * Event projeté pour inclusion dans un prompt Claude.
 * Version synthétique pour économiser tokens.
 */
export interface CorpusEventForPrompt {
  slug: string;
  title: string;
  dateStart: string;
  category: string;
  contextSummary: string;
  keyDrivers: string[];
  preconditions: string[];
  majorAssetImpacts: string[];
  lessonsLearned: string[];
  limitationsOfComparison: string[];
  tags: string[];
}
