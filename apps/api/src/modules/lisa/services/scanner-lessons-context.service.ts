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
// 28/05/2026 — Gemini 2.5 Pro = 2M context tokens. Pas besoin de cap arbitraire.
// User clarification : "il faut TOUTES les sauvegarder" → on injecte TOUT.
// Cap technique 1000 pour éviter prompt > 200k tokens, mais en pratique on
// est très loin de cette limite. Le score composite (confidence × log(sample))
// ordonne mais n'élimine plus de lesson.
const MAX_LESSONS_PER_BLOCK = 1000;

// Filter 03/06/2026 — anti-pollution Mistral sur lessons à faible sample.
// Constat : RealtimeLessonDetectorService génère des lessons avec sample_size=1
// (SL_GAP_FAILURE, BIG_LOSS, BIG_WIN, etc.) souvent avec conf 0.85+. Mistral
// lit ces lessons (texte Gemini verbeux avec "8%", "10%", "30 min" arbitraires)
// et applique strictement. Cas vérifié : PUMP_SCORE n=1 conf=0.90 a bloqué
// IFX.XETRA +9.52% pendant des heures parce que Mistral citait "8% requires
// pullback". Override env MIN_SAMPLE_SIZE_FOR_PROMPT pour ajuster.
// n=1 reste dans DB pour audit/historique — juste pas injecté dans prompts LLM.
const MIN_SAMPLE_SIZE_FOR_PROMPT = 5;

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

    // Filter : include 'all_scanner' + scope spécifique + scope(s) dérivé(s) d'assetClass
    const scopes = new Set<string>(['all_scanner', scope]);
    if (options?.assetClass) {
      const cls = options.assetClass.toLowerCase();
      // Note 28/05/2026 : "if" (pas "else if") pour supporter caller cross-classe
      // (ex: Trader Agent assetClass='asia_eu_us_crypto' active TOUS les scopes).
      if (cls.includes('asia')) scopes.add('asia_only');
      if (cls.includes('eu')) scopes.add('eu_only');
      if (cls.includes('us')) scopes.add('us_only');
      if (cls.includes('crypto')) scopes.add('crypto_only');
    }
    // Score composite (28/05/2026) — avec mémoire permanente potentiellement
    // milliers de lessons, on ne peut PAS se limiter à confidence seul.
    // Score = confidence × log(1 + sample_size) → favorise lessons à fort sample
    // tout en gardant confidence comme dimension principale. Évite que des lessons
    // n=5/conf=0.95 écrasent des lessons n=200/conf=0.80 (statistiquement meilleures).
    // Filter scope + sample size (anti-pollution Mistral n=1).
    // Env override : MIN_SAMPLE_SIZE_FOR_PROMPT (default 5).
    const minSample = Number(process.env.MIN_SAMPLE_SIZE_FOR_PROMPT ?? MIN_SAMPLE_SIZE_FOR_PROMPT);
    const filtered = lessons
      .filter((l) => scopes.has(l.scope))
      .filter((l) => (l.sample_size ?? 0) >= minSample)
      .map((l) => {
        const samplePenalty = Math.log(1 + (l.sample_size ?? 0));
        const score = l.confidence * (1 + samplePenalty * 0.15);
        return { lesson: l, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_LESSONS_PER_BLOCK)
      .map((e) => e.lesson);

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
        .limit(10000);  // MÉMOIRE PERMANENTE — pas de plafond pratique. Le cron
        // nightly génère ~5 lessons/jour × années = milliers de lessons. Le système
        // doit accumuler indéfiniment (cf. user 28/05/2026 : "sa mémoire doit aller
        // bien au-delà"). 10k = headroom multi-années. La sélection intelligente
        // (scope + confidence + sample_size) reste au niveau prompt (top N).
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
