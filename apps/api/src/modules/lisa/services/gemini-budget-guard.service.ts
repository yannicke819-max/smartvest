// GeminiBudgetGuardService — kill-switch quotidien Gemini avec override manuel.
//
// Contexte : 30/05/2026, dépassement plafond mensuel Google AI Studio (414€,
// service suspendu plusieurs heures). Le tracking interne `api_costs_daily`
// sous-déclare la facturation réelle (~5-50× selon les jours) — ce guard
// reste basé sur le tracking interne (rapide, O(1) Supabase lookup), avec
// un cap conservateur (default $30/jour) qui correspondrait à ~$150-300
// facturé réellement (marge × 5-10).
//
// Cf. migration 0177 + PR2 cost-cuts.

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { ApiCostTrackerService } from './api-cost-tracker.service';

/**
 * Lancée quand le hard cap Gemini quotidien est dépassé ET aucun override
 * manuel actif. Catchée par les wrappers du router LLM qui fallback à
 * `fallbackUsed=true` (comportement existant des providers KO).
 */
export class GeminiBudgetExceededError extends Error {
  readonly todayCostUsd: number;
  readonly hardCapUsd: number;

  constructor(todayCostUsd: number, hardCapUsd: number) {
    super(
      `[GEMINI_BUDGET_EXCEEDED] Coût Gemini quotidien $${todayCostUsd.toFixed(2)} >= ` +
      `hard cap $${hardCapUsd.toFixed(2)}. Override manuel requis ou attendre minuit UTC.`,
    );
    this.name = 'GeminiBudgetExceededError';
    this.todayCostUsd = todayCostUsd;
    this.hardCapUsd = hardCapUsd;
  }
}

export interface GeminiCostStatus {
  /** Coût Gemini agrégé pour aujourd'hui (date UTC). */
  todayUsd: number;
  /** Coût Gemini agrégé sur le mois en cours (date UTC). */
  monthToDateUsd: number;
  /** Hard cap quotidien depuis l'env GEMINI_DAILY_HARD_CAP_USD (default 30). */
  hardCapUsd: number;
  /** True si todayUsd >= hardCapUsd ET pas d'override actif. */
  killSwitchActive: boolean;
  /** True si l'utilisateur a forcé le bypass aujourd'hui. */
  manualOverrideActive: boolean;
  /** Timestamp de l'override courant (si actif). */
  overrideAt: string | null;
  /** Raison de l'override (si saisie). */
  overrideReason: string | null;
  /** Pourcentage de consommation du cap [0, 100+]. */
  capUsedPct: number;
  /** Date UTC du prochain reset auto (00:00 UTC demain). */
  nextResetUtc: string;
}

@Injectable()
export class GeminiBudgetGuardService {
  private readonly logger = new Logger(GeminiBudgetGuardService.name);
  private cachedStatus: { status: GeminiCostStatus; asOf: number } | null = null;
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly costTracker: ApiCostTrackerService,
  ) {}

  /**
   * Hard cap quotidien lu depuis l'env. Default $30 (conservateur).
   * Réajustable via Fly secret sans redeploy code.
   */
  getHardCapUsd(): number {
    const raw = this.config.get<string>('GEMINI_DAILY_HARD_CAP_USD');
    const parsed = Number.parseFloat(raw ?? '');
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return 30;
  }

  /**
   * Check si un appel Gemini est autorisé pour ce cycle. Cache 30s pour éviter
   * SUM Supabase à chaque LLM call.
   *
   * Décision :
   *   - Si todayUsd < cap → ALLOW
   *   - Si todayUsd >= cap ET override actif aujourd'hui → ALLOW (flag used_at)
   *   - Sinon → DENY
   */
  async isAllowed(): Promise<boolean> {
    const status = await this.getStatus();
    if (!status.killSwitchActive) return true;
    if (status.manualOverrideActive) {
      // Flag used_at au premier usage. Best-effort (ne bloque pas si fail).
      this.markOverrideUsed().catch((e) =>
        this.logger.debug(`[gemini-guard] markOverrideUsed fail: ${String(e).slice(0, 100)}`),
      );
      return true;
    }
    return false;
  }

  /**
   * Lève GeminiBudgetExceededError si non autorisé. À appeler avant chaque
   * llmRouter.call/callWithPro pour propager l'erreur jusqu'au caller qui
   * peut fallback à `fallbackUsed=true`.
   */
  async assertAllowed(): Promise<void> {
    const status = await this.getStatus();
    if (status.killSwitchActive && !status.manualOverrideActive) {
      throw new GeminiBudgetExceededError(status.todayUsd, status.hardCapUsd);
    }
    if (status.killSwitchActive && status.manualOverrideActive) {
      this.markOverrideUsed().catch(() => null);
    }
  }

  /**
   * Status complet pour endpoint API + UI panel.
   * Cache 30s, invalidé manuellement après recordCost ou manualOverride.
   */
  async getStatus(forceRefresh = false): Promise<GeminiCostStatus> {
    if (!forceRefresh && this.cachedStatus && Date.now() - this.cachedStatus.asOf < GeminiBudgetGuardService.CACHE_TTL_MS) {
      return this.cachedStatus.status;
    }
    const hardCap = this.getHardCapUsd();
    const [todayTotal, monthTotal, override] = await Promise.all([
      this.getTodayGeminiCost(),
      this.getMonthToDateGeminiCost(),
      this.getActiveOverride(),
    ]);
    const killSwitchActive = todayTotal >= hardCap;
    const manualOverrideActive = override !== null;
    const capUsedPct = hardCap > 0 ? Math.round((todayTotal / hardCap) * 1000) / 10 : 0;
    const status: GeminiCostStatus = {
      todayUsd: Math.round(todayTotal * 100) / 100,
      monthToDateUsd: Math.round(monthTotal * 100) / 100,
      hardCapUsd: hardCap,
      killSwitchActive,
      manualOverrideActive,
      overrideAt: override?.overridden_at ?? null,
      overrideReason: override?.reason ?? null,
      capUsedPct,
      nextResetUtc: this.getNextMidnightUtc(),
    };
    this.cachedStatus = { status, asOf: Date.now() };
    return status;
  }

  /**
   * Déclenche un override manuel pour aujourd'hui. Idempotent (1 row par date PK).
   * Returns le status post-override.
   */
  async manualOverride(opts: { userId?: string; reason?: string } = {}): Promise<GeminiCostStatus> {
    if (!this.supabase.isReady()) {
      this.logger.warn('[gemini-guard] supabase not ready, override skipped');
      return this.getStatus(true);
    }
    const today = this.getTodayUtcDate();
    try {
      const { error } = await this.supabase.getClient()
        .from('gemini_cost_override')
        .upsert(
          {
            date: today,
            overridden_at: new Date().toISOString(),
            overridden_by_user_id: opts.userId ?? null,
            reason: opts.reason ?? null,
          },
          { onConflict: 'date' },
        );
      if (error) {
        this.logger.warn(`[gemini-guard] override upsert failed: ${error.message}`);
      } else {
        this.logger.log(`[gemini-guard] manual override activated for ${today} (user=${opts.userId ?? '?'}, reason="${opts.reason ?? ''}")`);
      }
    } catch (e) {
      this.logger.warn(`[gemini-guard] override exception: ${String(e).slice(0, 100)}`);
    }
    // Invalidate cache to refresh next status read.
    this.cachedStatus = null;
    return this.getStatus(true);
  }

  /**
   * Supprime l'override actif pour aujourd'hui (utile pour test ou si user
   * change d'avis). Idempotent.
   */
  async clearOverride(): Promise<GeminiCostStatus> {
    if (!this.supabase.isReady()) return this.getStatus(true);
    const today = this.getTodayUtcDate();
    try {
      await this.supabase.getClient()
        .from('gemini_cost_override')
        .delete()
        .eq('date', today);
      this.logger.log(`[gemini-guard] manual override cleared for ${today}`);
    } catch (e) {
      this.logger.warn(`[gemini-guard] clearOverride exception: ${String(e).slice(0, 100)}`);
    }
    this.cachedStatus = null;
    return this.getStatus(true);
  }

  // ───────────────────────────────────────────────────────── private

  private async getTodayGeminiCost(): Promise<number> {
    if (!this.supabase.isReady()) return 0;
    try {
      const today = this.getTodayUtcDate();
      const { data } = await this.supabase.getClient()
        .from('api_costs_daily')
        .select('total_usd, by_model')
        .eq('date', today)
        .maybeSingle();
      if (!data) return 0;
      const byModel = (data.by_model as Record<string, number> | null) ?? {};
      let geminiTotal = 0;
      for (const [model, cost] of Object.entries(byModel)) {
        if (model.toLowerCase().includes('gemini')) {
          geminiTotal += Number(cost) || 0;
        }
      }
      // Si pas de breakdown Gemini, fallback sur total (tracking ancien sans by_model).
      return geminiTotal > 0 ? geminiTotal : Number(data.total_usd) || 0;
    } catch (e) {
      this.logger.debug(`[gemini-guard] getTodayGeminiCost fail: ${String(e).slice(0, 100)}`);
      return 0;
    }
  }

  private async getMonthToDateGeminiCost(): Promise<number> {
    if (!this.supabase.isReady()) return 0;
    try {
      const monthStart = this.getMonthStartUtcDate();
      const { data } = await this.supabase.getClient()
        .from('api_costs_daily')
        .select('total_usd, by_model')
        .gte('date', monthStart);
      if (!data || data.length === 0) return 0;
      let geminiTotal = 0;
      for (const row of data) {
        const byModel = (row.by_model as Record<string, number> | null) ?? {};
        for (const [model, cost] of Object.entries(byModel)) {
          if (model.toLowerCase().includes('gemini')) {
            geminiTotal += Number(cost) || 0;
          }
        }
      }
      return geminiTotal;
    } catch (e) {
      this.logger.debug(`[gemini-guard] getMonthToDateGeminiCost fail: ${String(e).slice(0, 100)}`);
      return 0;
    }
  }

  private async getActiveOverride(): Promise<{ overridden_at: string; reason: string | null } | null> {
    if (!this.supabase.isReady()) return null;
    try {
      const today = this.getTodayUtcDate();
      const { data } = await this.supabase.getClient()
        .from('gemini_cost_override')
        .select('overridden_at, reason')
        .eq('date', today)
        .maybeSingle();
      return (data as { overridden_at: string; reason: string | null } | null) ?? null;
    } catch (e) {
      this.logger.debug(`[gemini-guard] getActiveOverride fail: ${String(e).slice(0, 100)}`);
      return null;
    }
  }

  private async markOverrideUsed(): Promise<void> {
    if (!this.supabase.isReady()) return;
    const today = this.getTodayUtcDate();
    await this.supabase.getClient()
      .from('gemini_cost_override')
      .update({ used_at: new Date().toISOString() })
      .eq('date', today)
      .is('used_at', null);
  }

  private getTodayUtcDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private getMonthStartUtcDate(): string {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  private getNextMidnightUtc(): string {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return tomorrow.toISOString();
  }
}
