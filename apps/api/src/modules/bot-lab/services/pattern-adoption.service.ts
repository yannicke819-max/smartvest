import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import type { AdoptionLevel, LisaPatternAdoption } from '../types/bot-lab.types';

/**
 * PatternAdoptionService — Phase 4 du Bot Lab.
 *
 * Gère l'adoption de patterns par Lisa selon 3 niveaux :
 *  - OBSERVE : pattern visible dans la mémoire, aucune action automatique
 *  - SUGGEST : Lisa intègre le pattern dans son briefing comme suggestion
 *  - ENFORCE : Lisa refuse les thèses contredisant un pattern enforce
 *
 * Cette table (lisa_pattern_adoptions) est le SEUL pont entre le Bot Lab
 * et Lisa. Tout le reste du Bot Lab est isolé.
 *
 * Boucle feedback : recordTriggered() est appelé par lisa.service quand
 * une thèse Lisa matche un pattern adopté + trade fermé. Permet de
 * valider/invalider le pattern dans la durée.
 */
@Injectable()
export class PatternAdoptionService {
  private readonly logger = new Logger(PatternAdoptionService.name);

  constructor(private readonly supabase: SupabaseService) {}

  // ───────────────────────────────────────────────────────────────────
  // CRUD ADOPTIONS
  // ───────────────────────────────────────────────────────────────────

  /**
   * Adopt un pattern pour un portfolio à un niveau donné.
   * Idempotent par UNIQUE (portfolio_id, pattern_id) : si adoption existe,
   * met à jour le niveau.
   */
  async adopt(
    userId: string,
    portfolioId: string,
    patternId: string,
    level: AdoptionLevel,
    notes?: string,
  ): Promise<LisaPatternAdoption> {
    // Vérifier que le pattern appartient bien au user
    const { data: pattern } = await this.supabase.getClient()
      .from('bot_patterns')
      .select('id')
      .eq('id', patternId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!pattern) {
      throw new Error(`Pattern ${patternId} non trouvé ou non autorisé`);
    }

    const now = new Date().toISOString();
    const { data, error } = await this.supabase.getClient()
      .from('lisa_pattern_adoptions')
      .upsert(
        {
          user_id: userId,
          portfolio_id: portfolioId,
          pattern_id: patternId,
          adoption_level: level,
          adopted_at: now,
          adopted_by_user: true,
          adoption_notes: notes ?? null,
          is_active: true,
          deactivated_at: null,
          deactivation_reason: null,
        },
        { onConflict: 'portfolio_id,pattern_id' },
      )
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Adopt failed: ${error?.message ?? 'unknown'}`);
    }

    this.logger.log(
      `[ADOPTION] user=${userId.slice(0, 8)} portfolio=${portfolioId.slice(0, 8)} pattern=${patternId.slice(0, 8)} → ${level}`,
    );
    return this.mapRow(data);
  }

  /**
   * Désactive une adoption.
   */
  async deactivate(userId: string, adoptionId: string, reason?: string): Promise<void> {
    const { error } = await this.supabase.getClient()
      .from('lisa_pattern_adoptions')
      .update({
        is_active: false,
        deactivated_at: new Date().toISOString(),
        deactivation_reason: reason ?? 'user_action',
      })
      .eq('id', adoptionId)
      .eq('user_id', userId);

    if (error) throw new Error(`Deactivate failed: ${error.message}`);
  }

  /**
   * Liste les adoptions d'un portfolio.
   * Phase 4 : retourne aussi le pattern joint (pour UI display).
   */
  async listAdoptions(
    userId: string,
    portfolioId: string,
    activeOnly = true,
  ): Promise<Array<LisaPatternAdoption & { pattern_name?: string; pattern_conditions?: Record<string, unknown> }>> {
    let query = this.supabase.getClient()
      .from('lisa_pattern_adoptions')
      .select(`
        *,
        bot_patterns:pattern_id (name, conditions, composite_score, win_rate_pct)
      `)
      .eq('user_id', userId)
      .eq('portfolio_id', portfolioId)
      .order('adopted_at', { ascending: false });

    if (activeOnly) query = query.eq('is_active', true);

    const { data } = await query;
    return (data ?? []).map((row) => {
      const rawPattern = row.bot_patterns as unknown;
      const pat: Record<string, unknown> | null = Array.isArray(rawPattern)
        ? (rawPattern[0] as Record<string, unknown> | undefined) ?? null
        : (rawPattern as Record<string, unknown> | null);
      const base = this.mapRow(row);
      const result: LisaPatternAdoption & { pattern_name?: string; pattern_conditions?: Record<string, unknown> } = base;
      if (pat?.name) result.pattern_name = pat.name as string;
      if (pat?.conditions) result.pattern_conditions = pat.conditions as Record<string, unknown>;
      return result;
    });
  }

  /**
   * Charge les patterns adoptés ACTIFS pour un portfolio, avec leurs
   * conditions complètes. Utilisé par PatternBriefingService et
   * mechanical-trading pour les check ENFORCE.
   */
  async getActiveAdoptedPatterns(portfolioId: string): Promise<Array<{
    adoptionId: string;
    patternId: string;
    name: string;
    description: string | null;
    level: AdoptionLevel;
    conditions: Record<string, unknown>;
    actionSignal: Record<string, unknown> | null;
    winRatePct: number | null;
    expectancyUsd: string | null;
    compositeScore: number | null;
    triggeredCount: number;
    triggeredWinningCount: number;
  }>> {
    const { data } = await this.supabase.getClient()
      .from('lisa_pattern_adoptions')
      .select(`
        id,
        pattern_id,
        adoption_level,
        triggered_count,
        triggered_winning_count,
        bot_patterns:pattern_id (
          name, description, conditions, action_signal,
          win_rate_pct, expectancy_usd, composite_score
        )
      `)
      .eq('portfolio_id', portfolioId)
      .eq('is_active', true);

    if (!data) return [];

    return data.map((row) => {
      // Supabase peut retourner un array OU un object selon la relation
      const rawPattern = row.bot_patterns as unknown;
      const p: Record<string, unknown> | null = Array.isArray(rawPattern)
        ? (rawPattern[0] as Record<string, unknown> | undefined) ?? null
        : (rawPattern as Record<string, unknown> | null);
      return {
        adoptionId: row.id as string,
        patternId: row.pattern_id as string,
        name: (p?.name as string) ?? '?',
        description: (p?.description as string | null) ?? null,
        level: row.adoption_level as AdoptionLevel,
        conditions: (p?.conditions as Record<string, unknown>) ?? {},
        actionSignal: (p?.action_signal as Record<string, unknown> | null) ?? null,
        winRatePct: (p?.win_rate_pct as number | null) ?? null,
        expectancyUsd: (p?.expectancy_usd as string | null) ?? null,
        compositeScore: (p?.composite_score as number | null) ?? null,
        triggeredCount: Number(row.triggered_count ?? 0),
        triggeredWinningCount: Number(row.triggered_winning_count ?? 0),
      };
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // BOUCLE FEEDBACK
  // ───────────────────────────────────────────────────────────────────

  /**
   * Enregistre qu'un trade Lisa a matché un pattern adopté.
   * Appelé par lisa.service après chaque close de position si match.
   *
   * Update :
   *  - triggered_count++
   *  - triggered_winning_count++ si pnl > 0
   *  - triggered_total_pnl_usd += pnl
   *  - last_triggered_at = now
   */
  async recordTriggered(adoptionId: string, pnlUsd: number): Promise<void> {
    const isWin = pnlUsd > 0;

    // Lecture du current state pour increment
    const { data: current } = await this.supabase.getClient()
      .from('lisa_pattern_adoptions')
      .select('triggered_count, triggered_winning_count, triggered_total_pnl_usd')
      .eq('id', adoptionId)
      .maybeSingle();

    if (!current) return;

    const newCount = Number(current.triggered_count ?? 0) + 1;
    const newWinning = Number(current.triggered_winning_count ?? 0) + (isWin ? 1 : 0);
    const newTotalPnl = parseFloat(String(current.triggered_total_pnl_usd ?? 0)) + pnlUsd;

    await this.supabase.getClient()
      .from('lisa_pattern_adoptions')
      .update({
        triggered_count: newCount,
        triggered_winning_count: newWinning,
        triggered_total_pnl_usd: newTotalPnl.toFixed(2),
        last_triggered_at: new Date().toISOString(),
      })
      .eq('id', adoptionId);

    this.logger.debug(
      `[ADOPTION] feedback adoption=${adoptionId.slice(0, 8)} pnl=${pnlUsd.toFixed(2)} count=${newCount}`,
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // PATTERN MATCHING
  // ───────────────────────────────────────────────────────────────────

  /**
   * Détermine si un trade matche les conditions d'un pattern.
   * Conditions Phase 3 = { asset_class, direction, vix_bucket }.
   *
   * Pure function, utilisable pour le check ENFORCE avant ouverture
   * et pour la boucle feedback après close.
   */
  matchesPattern(
    tradeContext: {
      assetClass: string;
      direction: string;
      vixAtEntry?: number | null;
    },
    conditions: Record<string, unknown>,
  ): boolean {
    if (conditions.asset_class && conditions.asset_class !== tradeContext.assetClass) return false;
    if (conditions.direction && conditions.direction !== tradeContext.direction) return false;

    if (conditions.vix_bucket && tradeContext.vixAtEntry != null) {
      const tradeBucket = this.vixToBucket(tradeContext.vixAtEntry);
      if (conditions.vix_bucket !== tradeBucket) return false;
    }

    return true;
  }

  private vixToBucket(vix: number): string {
    if (vix < 15) return 'vix_low';
    if (vix < 22) return 'vix_normal';
    if (vix < 30) return 'vix_high';
    return 'vix_extreme';
  }

  // ───────────────────────────────────────────────────────────────────
  // HELPERS
  // ───────────────────────────────────────────────────────────────────

  private mapRow(row: Record<string, unknown>): LisaPatternAdoption {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      portfolioId: row.portfolio_id as string,
      patternId: row.pattern_id as string,
      adoptionLevel: row.adoption_level as AdoptionLevel,
      adoptedAt: row.adopted_at as string,
      adoptedByUser: (row.adopted_by_user as boolean) ?? true,
      adoptionNotes: (row.adoption_notes as string | null) ?? null,
      triggeredCount: Number(row.triggered_count ?? 0),
      triggeredWinningCount: Number(row.triggered_winning_count ?? 0),
      triggeredTotalPnlUsd: String(row.triggered_total_pnl_usd ?? 0),
      lastTriggeredAt: (row.last_triggered_at as string | null) ?? null,
      isActive: (row.is_active as boolean) ?? true,
      deactivatedAt: (row.deactivated_at as string | null) ?? null,
      deactivationReason: (row.deactivation_reason as string | null) ?? null,
    };
  }
}
