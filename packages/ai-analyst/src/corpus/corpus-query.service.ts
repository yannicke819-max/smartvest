/**
 * CorpusQueryService — Accès au corpus historique pour Lisa
 *
 * Fournit :
 *  - fetchByTags() : matching par tags (similar_setups_tags GIN index)
 *  - fetchBySlug() : récupération directe (citations Claude)
 *  - fetchRelevantForContext() : ranking + sélection pour prompt
 *  - projectForPrompt() : réduction tokens pour inclusion dans message Claude
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CorpusEventForPrompt,
  CorpusQueryFilters,
  HistoricalEvent,
} from './types';

export class CorpusQueryService {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Fetch events matching any of the provided tags (OR logic via GIN index).
   * Most relevant query pour Lisa : "setup X me fait penser à ces tags".
   */
  async fetchByTags(tags: string[], limit = 5): Promise<HistoricalEvent[]> {
    if (tags.length === 0) return [];

    const { data, error } = await this.supabase
      .from('historical_events_corpus')
      .select('*')
      .overlaps('similar_setups_tags', tags)
      .order('severity_at_peak', { ascending: false })
      .limit(limit);

    if (error) throw new Error(`Corpus query failed: ${error.message}`);
    return (data ?? []).map(this.mapRow);
  }

  /**
   * Fetch event(s) by slug — utilisé quand Claude cite explicitement un analog.
   */
  async fetchBySlug(slugs: string[]): Promise<HistoricalEvent[]> {
    if (slugs.length === 0) return [];

    const { data, error } = await this.supabase
      .from('historical_events_corpus')
      .select('*')
      .in('slug', slugs);

    if (error) throw new Error(`Corpus query failed: ${error.message}`);
    return (data ?? []).map(this.mapRow);
  }

  /**
   * Fetch filtered events with multi-criteria.
   */
  async fetchFiltered(filters: CorpusQueryFilters): Promise<HistoricalEvent[]> {
    let query = this.supabase.from('historical_events_corpus').select('*');

    if (filters.tags && filters.tags.length > 0) {
      query = query.overlaps('similar_setups_tags', filters.tags);
    }
    if (filters.categories && filters.categories.length > 0) {
      query = query.in('category', filters.categories);
    }
    if (filters.minSeverity) {
      const severityOrder = ['info', 'watch', 'warning', 'critical', 'systemic'];
      const minIdx = severityOrder.indexOf(filters.minSeverity);
      const allowed = severityOrder.slice(minIdx);
      query = query.in('severity_at_peak', allowed);
    }

    query = query.order('date_start', { ascending: false }).limit(filters.limit ?? 10);

    const { data, error } = await query;
    if (error) throw new Error(`Corpus query failed: ${error.message}`);
    return (data ?? []).map(this.mapRow);
  }

  /**
   * Fetch ALL events (small corpus, ~25 events) — pour inclusion initiale
   * dans le prompt Claude quand on veut un contexte large.
   */
  async fetchAll(): Promise<HistoricalEvent[]> {
    const { data, error } = await this.supabase
      .from('historical_events_corpus')
      .select('*')
      .order('date_start', { ascending: true });

    if (error) throw new Error(`Corpus query failed: ${error.message}`);
    return (data ?? []).map(this.mapRow);
  }

  /**
   * Projection compacte pour inclusion dans un prompt Claude.
   * Extrait les champs essentiels et réduit la verbosité.
   * 25 événements × ~400 tokens / projection = ~10k tokens corpus complet.
   */
  projectForPrompt(event: HistoricalEvent): CorpusEventForPrompt {
    const majorAssetImpacts = this.extractMajorAssetImpacts(event.marketImpactByAssetClass);

    return {
      slug: event.slug,
      title: event.title,
      dateStart: event.dateStart,
      category: event.category,
      contextSummary: this.truncate(event.contextDescription, 400),
      keyDrivers: event.keyDrivers.slice(0, 5),
      preconditions: event.preconditions.slice(0, 5),
      majorAssetImpacts,
      lessonsLearned: event.lessonsLearned.slice(0, 5),
      limitationsOfComparison: event.limitationsOfComparison.slice(0, 4),
      tags: event.similarSetupsTags,
    };
  }

  /**
   * Sérialise le corpus projeté pour inclusion dans un prompt Claude.
   * Format Markdown-like lisible par l'LLM.
   */
  serializeCorpusForPrompt(events: CorpusEventForPrompt[]): string {
    return events
      .map((e) => {
        const impactsBlock = e.majorAssetImpacts.length > 0
          ? `Impacts: ${e.majorAssetImpacts.join('; ')}`
          : '';
        return `
### ${e.slug} — ${e.title} (${e.dateStart}, ${e.category})
${e.contextSummary}

Drivers: ${e.keyDrivers.join(' | ')}
Preconditions: ${e.preconditions.join(' | ')}
${impactsBlock}
Lessons: ${e.lessonsLearned.join(' | ')}
Limitations vs today: ${e.limitationsOfComparison.join(' | ')}
Tags: [${e.tags.join(', ')}]
`.trim();
      })
      .join('\n\n---\n\n');
  }

  /**
   * Extrait les impacts majeurs (drawdown, return, yield move) les plus
   * parlants depuis market_impact_by_asset_class JSONB.
   */
  private extractMajorAssetImpacts(impacts: Record<string, Record<string, unknown>>): string[] {
    const lines: string[] = [];
    for (const [assetKey, metrics] of Object.entries(impacts)) {
      const pieces: string[] = [];
      for (const [metricKey, value] of Object.entries(metrics)) {
        if (
          metricKey.includes('drawdown_pct') ||
          metricKey.includes('return_pct') ||
          metricKey.includes('yield_move_bps') ||
          metricKey.includes('peak') ||
          metricKey.includes('move_pct')
        ) {
          pieces.push(`${metricKey}=${String(value)}`);
        }
      }
      if (pieces.length > 0) {
        lines.push(`${assetKey}: ${pieces.slice(0, 3).join(', ')}`);
      }
    }
    return lines.slice(0, 8);
  }

  private truncate(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 3) + '...';
  }

  /**
   * Mappe une row DB brute vers l'interface HistoricalEvent.
   * Les champs snake_case deviennent camelCase.
   */
  private mapRow(row: Record<string, unknown>): HistoricalEvent {
    return {
      id: row.id as string,
      slug: row.slug as string,
      title: row.title as string,
      category: row.category as string,
      dateStart: row.date_start as string,
      dateEnd: (row.date_end as string | null) ?? null,
      durationDescription: (row.duration_description as string | null) ?? null,
      contextDescription: row.context_description as string,
      keyDrivers: (row.key_drivers as string[] | null) ?? [],
      preconditions: (row.preconditions as string[] | null) ?? [],
      marketImpactByAssetClass: (row.market_impact_by_asset_class as Record<string, Record<string, unknown>> | null) ?? {},
      regimeShift: (row.regime_shift as Record<string, unknown> | null) ?? null,
      resolution: (row.resolution as string | null) ?? null,
      lessonsLearned: (row.lessons_learned as string[] | null) ?? [],
      limitationsOfComparison: (row.limitations_of_comparison as string[] | null) ?? [],
      similarSetupsTags: (row.similar_setups_tags as string[] | null) ?? [],
      severityAtPeak: row.severity_at_peak as HistoricalEvent['severityAtPeak'],
      dataQuality: row.data_quality as HistoricalEvent['dataQuality'],
      references: (row.references as Array<Record<string, unknown>> | null) ?? [],
    };
  }
}
