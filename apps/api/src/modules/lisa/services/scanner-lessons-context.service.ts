/**
 * ScannerLessonsContextService — fournit le bloc Markdown des lessons actives
 * à injecter dans les system prompts Gemini (scanner signal, ranking, risk
 * manager, macro veto).
 *
 * Source : table scanner_lessons (migration 0170), peuplée par
 * MainScannerPostMortemService cron 02:30 UTC daily.
 *
 * Cache TTL 5 min pour éviter une query DB à chaque appel LLM (le scanner
 * principal fait ~500 appels/cycle × 12 cycles/h).
 *
 * Filtrage :
 *  - Toujours include scope='all_scanner' (lessons universelles)
 *  - Plus le scope spécifique (asset_class du candidat / position)
 *  - Top 10 par confidence DESC pour éviter de saturer le prompt
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_LESSONS_PER_BLOCK = 10;

interface LessonRow {
  lesson_kind: string;
  lesson_text: string;
  macro_condition: string | null;
  scope: string;
  confidence: number;
  sample_size: number | null;
  win_rate_observed: number | null;
}

@Injectable()
export class ScannerLessonsContextService {
  private readonly logger = new Logger(ScannerLessonsContextService.name);
  private cache: { lessons: LessonRow[]; fetchedAt: number } | null = null;

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Retourne un bloc Markdown formaté des lessons actives à injecter dans un
   * system prompt Gemini. Vide si aucune lesson n'est applicable.
   *
   * @param scope 'all_scanner' | 'asia_only' | 'eu_only' | 'us_only' | 'crypto_only' | 'main_only' | 'shadows_only'
   * @param assetClass optionnel — si fourni, filtre supplémentaire (ex: 'asia_equity' → match scope 'asia_only')
   */
  async getLessonsBlock(scope: string, options?: { assetClass?: string }): Promise<string> {
    const lessons = await this.getActiveLessons();
    if (lessons.length === 0) return '';

    // Filter : include 'all_scanner' + scope spécifique + scope dérivé d'assetClass
    const scopes = new Set<string>(['all_scanner', scope]);
    if (options?.assetClass) {
      const cls = options.assetClass.toLowerCase();
      if (cls.includes('asia')) scopes.add('asia_only');
      else if (cls.includes('eu')) scopes.add('eu_only');
      else if (cls.includes('us')) scopes.add('us_only');
      else if (cls.includes('crypto')) scopes.add('crypto_only');
    }
    const filtered = lessons
      .filter((l) => scopes.has(l.scope))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_LESSONS_PER_BLOCK);

    if (filtered.length === 0) return '';

    const lines = filtered.map((l, i) => {
      const macro = l.macro_condition ? ` [${l.macro_condition}]` : '';
      const stats = l.sample_size !== null && l.win_rate_observed !== null
        ? ` (n=${l.sample_size}, WR=${l.win_rate_observed}%)`
        : '';
      return `${i + 1}. ${l.lesson_text}${macro}${stats} (conf=${l.confidence})`;
    });
    return `LEÇONS APPRISES (post-mortem nightly, à respecter en priorité) :\n${lines.join('\n')}`;
  }

  /** Force un refresh du cache (utile en tests). */
  invalidateCache(): void {
    this.cache = null;
  }

  private async getActiveLessons(): Promise<LessonRow[]> {
    const now = Date.now();
    if (this.cache && (now - this.cache.fetchedAt) < CACHE_TTL_MS) {
      return this.cache.lessons;
    }
    try {
      const { data, error } = await this.supabase.getClient()
        .from('scanner_lessons')
        .select('lesson_kind, lesson_text, macro_condition, scope, confidence, sample_size, win_rate_observed')
        .eq('is_active', true)
        .order('confidence', { ascending: false })
        .limit(500);  // Cumulatif jour après jour (post-mortem nightly cron). Avec
        // ~5 lessons/nuit × 6 semaines = 210 lessons attendues. 500 = headroom
        // confortable. Le top 10 par scope reste injecté au prompt (MAX_LESSONS_PER_BLOCK).
      if (error) {
        this.logger.warn(`[scanner-lessons-context] fetch failed: ${error.message}`);
        // Garde l'ancien cache si dispo, sinon empty
        return this.cache?.lessons ?? [];
      }
      this.cache = { lessons: (data ?? []) as LessonRow[], fetchedAt: now };
      return this.cache.lessons;
    } catch (e) {
      this.logger.warn(`[scanner-lessons-context] fetch threw: ${String(e).slice(0, 100)}`);
      return this.cache?.lessons ?? [];
    }
  }
}
