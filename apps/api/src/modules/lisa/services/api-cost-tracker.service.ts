import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * Erreur lancée quand le budget journalier API est dépassé. Catchée par
 * `LisaService.generateProposal` qui désactive l'autopilot en upsert sur
 * `lisa_session_configs.autopilot_enabled = false`.
 *
 * Cf. PATCH 4 risk-04-adaptive-safetynet-budget.
 */
export class BudgetExceededError extends Error {
  readonly todayCostUsd: number;
  readonly budgetUsd: number;

  constructor(todayCostUsd: number, budgetUsd: number) {
    super(
      `[BUDGET_EXCEEDED] Coût API journalier $${todayCostUsd.toFixed(2)} >= ` +
      `budget $${budgetUsd.toFixed(2)}. Autopilot désactivé.`,
    );
    this.name = 'BudgetExceededError';
    this.todayCostUsd = todayCostUsd;
    this.budgetUsd = budgetUsd;
  }
}

/**
 * ApiCostTrackerService — running total des coûts API journaliers + persistance.
 *
 * Pourquoi un service dédié plutôt que cost-engine package ?
 * `@smartvest/cost-engine` traite les frais BROKER (transaction fees,
 * spread, slippage, FX markup) — domaine métier différent. Les coûts
 * API LLM sont infrastructure, pas trade execution.
 *
 * Source de vérité primaire : `lisa_proposals.claude_cost_usd` (existant).
 * Ce service AGRÈGE par jour dans `api_costs_daily` pour permettre :
 *   - Lecture O(1) pour le hard-stop budget (pas de SUM full table à chaque cycle)
 *   - Breakdown by_model JSONB pour PATCH 7 (LLM router) plus tard
 *
 * Cf. PATCH 4 risk-04-adaptive-safetynet-budget.
 */
@Injectable()
export class ApiCostTrackerService {
  private readonly logger = new Logger(ApiCostTrackerService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Total coûts API consommés depuis 00:00 UTC aujourd'hui (USD).
   * Utilisé par le hard-stop budget côté lisa.service.generateProposal.
   *
   * Lit en priorité l'agrégat `api_costs_daily` (pré-calculé), fallback sur
   * SUM live de `lisa_proposals` si la table d'agrégat est absente
   * (migration 0072 pas encore appliquée).
   */
  async getTodayTotalUsd(): Promise<number> {
    const today = this.getTodayUtcDate();

    // 1. Tentative table d'agrégat (rapide, post-migration 0072)
    try {
      const { data, error } = await this.supabase.getClient()
        .from('api_costs_daily')
        .select('total_usd')
        .eq('date', today)
        .maybeSingle();
      if (!error && data && typeof data.total_usd !== 'undefined') {
        return Number(data.total_usd) || 0;
      }
      if (error && !/api_costs_daily.*does not exist/i.test(error.message)) {
        this.logger.debug(`api_costs_daily read failed: ${error.message}`);
      }
    } catch (e) {
      this.logger.debug(`api_costs_daily query exception: ${String(e).slice(0, 100)}`);
    }

    // 2. Fallback : SUM live depuis lisa_proposals (toujours disponible)
    try {
      const startUtc = `${today}T00:00:00.000Z`;
      const { data, error } = await this.supabase.getClient()
        .from('lisa_proposals')
        .select('claude_cost_usd')
        .gte('created_at', startUtc);
      if (error) {
        this.logger.warn(`lisa_proposals SUM fallback failed: ${error.message}`);
        return 0;
      }
      return (data ?? []).reduce(
        (sum, row) => sum + Number(row.claude_cost_usd ?? 0),
        0,
      );
    } catch (e) {
      this.logger.warn(`getTodayTotalUsd fallback exception: ${String(e).slice(0, 100)}`);
      return 0;
    }
  }

  /**
   * Enregistre un appel API : incrémente le total journalier (UPSERT) et
   * la breakdown par modèle. Idempotent à la grain "appel atomique" — appelé
   * 1× par appel Claude réussi (cf. lisa.service après generateTheses).
   *
   * Si la table api_costs_daily n'existe pas (migration pas encore
   * appliquée), no-op silencieux. Le SUM live de getTodayTotalUsd() prend
   * le relais.
   */
  async recordApiCost(model: string, costUsd: number): Promise<void> {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    const today = this.getTodayUtcDate();

    try {
      // Lecture du row courant (pour merger by_model + cumuler total)
      const { data: existing } = await this.supabase.getClient()
        .from('api_costs_daily')
        .select('total_usd, by_model')
        .eq('date', today)
        .maybeSingle();

      const prevTotal = existing ? Number(existing.total_usd ?? 0) : 0;
      const prevByModel = (existing?.by_model as Record<string, number> | null) ?? {};
      const nextByModel = {
        ...prevByModel,
        [model]: Number(prevByModel[model] ?? 0) + costUsd,
      };

      const { error } = await this.supabase.getClient()
        .from('api_costs_daily')
        .upsert(
          {
            date: today,
            total_usd: prevTotal + costUsd,
            by_model: nextByModel,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'date' },
        );
      if (error && !/api_costs_daily.*does not exist/i.test(error.message)) {
        this.logger.warn(`api_costs_daily upsert failed: ${error.message}`);
      }
    } catch (e) {
      this.logger.debug(`recordApiCost exception (non-blocking): ${String(e).slice(0, 100)}`);
    }
  }

  /** Date UTC YYYY-MM-DD du jour courant. */
  private getTodayUtcDate(): string {
    const now = new Date();
    return now.toISOString().slice(0, 10);
  }
}
