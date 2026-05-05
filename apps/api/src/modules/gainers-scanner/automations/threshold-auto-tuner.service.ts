/**
 * PR #5 — ThresholdAutoTunerService (Phase C minimal).
 *
 * Boucle d'apprentissage active : lit FP-rate par gate × env_tag depuis
 * gainers_signal_forward (RCFT data), propose des ajustements de seuils,
 * applique avec garde-fous, audite via gainers_threshold_history.
 *
 * Cron daily 03:00 UTC. Activable par portfolio via flags :
 *   - lisa_session_configs.gainers_auto_tuner_enabled (default false)
 *   - lisa_session_configs.gainers_auto_tuner_env ('shadow' | 'canary' | 'prod')
 *
 * Logique suggestion :
 *   - REJECT-side (gate trop strict) : fp_rate > FP_HIGH_THRESHOLD (0.20)
 *     champions/(total REJECT) > 20% = on rejette trop de bons trades
 *     → suggère -5% sur le seuil (assouplir)
 *   - ACCEPT-side (gate trop laxiste) : failure_rate > FAILURE_HIGH (0.30)
 *     failures/(total ACCEPT) > 30% = on ouvre trop de mauvais trades
 *     → suggère +5% sur le seuil (resserrer)
 *
 * Garde-fous :
 *   - min_samples = 50 (pas d'ajustement sur n<50)
 *   - cap mouvement ±5% par run, ±20% sur 30j (lookup history)
 *   - anti-flap : 1 seul ajustement par (portfolio, threshold) par 7j
 *   - bracket : seuils respectent floors ADR-005 (persistence ∈ [0.5, 1.0],
 *     path_eff ∈ [0.3, 0.9])
 *   - kill-switch global : env GAINERS_AUTO_TUNER_KILL_SWITCH=true → pause
 *
 * Scope minimal MVP : 2 seuils ajustables (persistence_score + path_efficiency).
 * Les autres seuils (liquidity/mcap/volatility) sont hardcodés au niveau
 * Bloc 1 prefilter-gates.ts ADR-005 §1bis lock — modification = code change
 * + nouvelle migration ALTER TABLE pour exposer per-portfolio.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { RejectedInsightsService } from './rejected-insights.service';
import { GainersInsightsService } from '../insights/gainers-insights.service';

/** FP-rate ≥ ce seuil = gate trop strict (rejette trop de champions). */
const FP_HIGH_THRESHOLD = 0.20;
/** Failure-rate ≥ ce seuil = gate trop laxiste (accepte trop de failures). */
const FAILURE_HIGH_THRESHOLD = 0.30;
/** Magnitude de l'ajustement (±5% relatif). */
const TUNE_MAGNITUDE = 0.05;
/** Cap mouvement cumulé sur 30j (anti-drift incontrôlé). */
const CAP_30D_MAGNITUDE = 0.20;
/** Sample minimum pour décider (sinon insufficient_data → skip). */
const MIN_SAMPLES = 50;
/** Anti-flap : pas plus d'1 ajustement par (portfolio, threshold) par N jours. */
const ANTI_FLAP_DAYS = 7;
/** Brackets ADR-005 : valeurs absolues plancher/plafond par seuil. */
const THRESHOLD_BRACKETS: Record<string, { min: number; max: number }> = {
  gainers_min_persistence_score: { min: 0.5, max: 1.0 },
  gainers_min_path_efficiency: { min: 0.3, max: 0.9 },
};
/** Mapping reject_reason → colonne lisa_session_configs. */
const REJECT_REASON_TO_THRESHOLD: Record<string, string> = {
  PERSISTENCE_BELOW_THRESHOLD: 'gainers_min_persistence_score',
  PATH_EFFICIENCY_LOW: 'gainers_min_path_efficiency',
};

interface PortfolioConfig {
  portfolio_id: string;
  gainers_auto_tuner_env: 'shadow' | 'canary' | 'prod' | null;
  gainers_min_persistence_score: number | null;
  gainers_min_path_efficiency: number | null;
}

interface TuneSuggestion {
  thresholdName: string;
  oldValue: number;
  newValue: number;
  reason: 'fp_rate_too_high' | 'failure_rate_too_high';
  fpRateObserved: number | null;
  failureRateObserved: number | null;
  sampleSize: number;
}

@Injectable()
export class ThresholdAutoTunerService {
  private readonly logger = new Logger(ThresholdAutoTunerService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly rejected: RejectedInsightsService,
    private readonly insights: GainersInsightsService,
    private readonly config: ConfigService,
  ) {}

  /** Cron daily 03:00 UTC strict. */
  @Cron('0 3 * * *', { timeZone: 'UTC' })
  async runAutoTuneCycle(): Promise<void> {
    if (this.isKillSwitchActive()) {
      this.logger.log('[auto-tuner] GAINERS_AUTO_TUNER_KILL_SWITCH=true — cron skipped');
      return;
    }
    try {
      await this.runInner();
    } catch (e) {
      this.logger.error(`[auto-tuner] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  isKillSwitchActive(): boolean {
    return (this.config.get<string>('GAINERS_AUTO_TUNER_KILL_SWITCH') ?? 'false').toLowerCase() === 'true';
  }

  private async runInner(): Promise<void> {
    const portfolios = await this.loadEnabledPortfolios();
    if (portfolios.length === 0) {
      this.logger.log('[auto-tuner] no portfolio with gainers_auto_tuner_enabled=true');
      return;
    }

    let totalApplied = 0;
    let totalSkipped = 0;

    for (const portfolio of portfolios) {
      const env = portfolio.gainers_auto_tuner_env ?? 'shadow';
      const fpRate = await this.rejected.getFalsePositiveRate({
        envTag: env,
        sinceDays: 14,
        minSamples: MIN_SAMPLES,
      }).catch((e) => {
        this.logger.warn(`[auto-tuner] FP-rate fetch failed for ${portfolio.portfolio_id.slice(0, 8)}: ${String(e).slice(0, 100)}`);
        return null;
      });
      if (!fpRate) continue;

      const suggestions = this.computeSuggestions(portfolio, fpRate);
      for (const sugg of suggestions) {
        const blocked = await this.checkAntiFlap(portfolio.portfolio_id, sugg.thresholdName);
        if (blocked) {
          totalSkipped++;
          this.logger.log(
            `[auto-tuner] ${portfolio.portfolio_id.slice(0, 8)} ${sugg.thresholdName}: anti-flap (ajusté < ${ANTI_FLAP_DAYS}j) → skip`,
          );
          continue;
        }
        const cap = await this.checkCap30d(portfolio.portfolio_id, sugg.thresholdName, sugg);
        if (cap.blocked) {
          totalSkipped++;
          this.logger.log(
            `[auto-tuner] ${portfolio.portfolio_id.slice(0, 8)} ${sugg.thresholdName}: cap 30j atteint (${cap.cumulativePct.toFixed(2)}) → skip`,
          );
          continue;
        }
        await this.applySuggestion(portfolio.portfolio_id, sugg, env);
        totalApplied++;
      }
    }

    this.logger.log(
      `[auto-tuner] cycle complete: applied=${totalApplied} skipped=${totalSkipped} portfolios=${portfolios.length}`,
    );
  }

  /**
   * Pure helper exposé pour tests : compute suggestions à partir de fpRate
   * stats déjà fetched + portfolio config courante. Pas d'I/O.
   */
  computeSuggestions(
    portfolio: PortfolioConfig,
    fpRate: Awaited<ReturnType<RejectedInsightsService['getFalsePositiveRate']>>,
  ): TuneSuggestion[] {
    const out: TuneSuggestion[] = [];

    for (const [rejectReason, thresholdName] of Object.entries(REJECT_REASON_TO_THRESHOLD)) {
      const stats = fpRate.by_reason[rejectReason];
      if (!stats || stats.status !== 'ok') continue;
      if (stats.total < MIN_SAMPLES) continue;

      const currentValue = (portfolio as unknown as Record<string, number | null>)[thresholdName];
      if (currentValue == null) continue;

      // REJECT-side : si fp_rate > seuil, gate trop strict → assouplir (-5%)
      if (stats.fp_rate != null && stats.fp_rate > FP_HIGH_THRESHOLD) {
        const suggestion = this.proposeAdjustment(thresholdName, currentValue, -TUNE_MAGNITUDE);
        if (suggestion != null) {
          out.push({
            thresholdName,
            oldValue: currentValue,
            newValue: suggestion,
            reason: 'fp_rate_too_high',
            fpRateObserved: stats.fp_rate,
            failureRateObserved: null,
            sampleSize: stats.total,
          });
        }
      }
    }

    // ACCEPT-side : failures in accept stats. Suggère resserrer le seuil
    // dominant (heuristique simple : on bumps le persistence_score qui est
    // le gate principal éligible avant ouverture).
    const accept = fpRate.accept_stats;
    if (
      accept.status === 'ok'
      && accept.total >= MIN_SAMPLES
      && accept.failure_rate != null
      && accept.failure_rate > FAILURE_HIGH_THRESHOLD
    ) {
      const currentValue = portfolio.gainers_min_persistence_score;
      if (currentValue != null) {
        const suggestion = this.proposeAdjustment(
          'gainers_min_persistence_score',
          currentValue,
          +TUNE_MAGNITUDE,
        );
        if (suggestion != null) {
          out.push({
            thresholdName: 'gainers_min_persistence_score',
            oldValue: currentValue,
            newValue: suggestion,
            reason: 'failure_rate_too_high',
            fpRateObserved: null,
            failureRateObserved: accept.failure_rate,
            sampleSize: accept.total,
          });
        }
      }
    }

    return out;
  }

  /** Calcule new = current × (1 + delta), clamp dans bracket ADR-005. */
  private proposeAdjustment(
    thresholdName: string,
    currentValue: number,
    delta: number,
  ): number | null {
    const bracket = THRESHOLD_BRACKETS[thresholdName];
    if (!bracket) return null;
    const proposed = currentValue * (1 + delta);
    const clamped = Math.max(bracket.min, Math.min(bracket.max, proposed));
    // Skip si delta effectif < 1% (clamp absorbe tout le mouvement)
    const effectiveDelta = Math.abs(clamped - currentValue) / currentValue;
    if (effectiveDelta < 0.01) return null;
    return Math.round(clamped * 1000) / 1000; // 3 décimales
  }

  private async checkAntiFlap(portfolioId: string, thresholdName: string): Promise<boolean> {
    const sinceIso = new Date(Date.now() - ANTI_FLAP_DAYS * 24 * 3600_000).toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_threshold_history')
      .select('id')
      .eq('portfolio_id', portfolioId)
      .eq('threshold_name', thresholdName)
      .gte('applied_at', sinceIso)
      .limit(1);
    if (error) {
      this.logger.warn(`[auto-tuner] checkAntiFlap query failed: ${error.message}`);
      return false; // fail-open : on laisse passer plutôt que bloquer
    }
    return (data ?? []).length > 0;
  }

  private async checkCap30d(
    portfolioId: string,
    thresholdName: string,
    sugg: TuneSuggestion,
  ): Promise<{ blocked: boolean; cumulativePct: number }> {
    const sinceIso = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_threshold_history')
      .select('old_value, new_value')
      .eq('portfolio_id', portfolioId)
      .eq('threshold_name', thresholdName)
      .gte('applied_at', sinceIso);
    if (error) {
      this.logger.warn(`[auto-tuner] checkCap30d query failed: ${error.message}`);
      return { blocked: false, cumulativePct: 0 };
    }
    let cumulativePct = 0;
    for (const row of data ?? []) {
      const old_v = Number(row.old_value);
      const new_v = Number(row.new_value);
      if (old_v > 0) cumulativePct += Math.abs(new_v - old_v) / old_v;
    }
    // Inclut la suggestion en cours pour décision
    const proposedDelta = Math.abs(sugg.newValue - sugg.oldValue) / sugg.oldValue;
    cumulativePct += proposedDelta;
    return {
      blocked: cumulativePct > CAP_30D_MAGNITUDE,
      cumulativePct,
    };
  }

  private async applySuggestion(
    portfolioId: string,
    sugg: TuneSuggestion,
    env: 'shadow' | 'canary' | 'prod',
  ): Promise<void> {
    // 1. Update lisa_session_configs (sauf en shadow où on log uniquement)
    if (env !== 'shadow') {
      const { error: updErr } = await this.supabase
        .getClient()
        .from('lisa_session_configs')
        .update({ [sugg.thresholdName]: sugg.newValue })
        .eq('portfolio_id', portfolioId);
      if (updErr) {
        this.logger.warn(`[auto-tuner] update threshold failed: ${updErr.message}`);
        return;
      }
    }

    // 2. Append to history (audit append-only, toujours écrit même en shadow)
    const { error: histErr } = await this.supabase.getClient().from('gainers_threshold_history').insert({
      portfolio_id: portfolioId,
      threshold_name: sugg.thresholdName,
      old_value: String(sugg.oldValue),
      new_value: String(sugg.newValue),
      reason: sugg.reason,
      fp_rate_observed: sugg.fpRateObserved != null ? String(sugg.fpRateObserved) : null,
      failure_rate_observed: sugg.failureRateObserved != null ? String(sugg.failureRateObserved) : null,
      sample_size: sugg.sampleSize,
      applied_to_env: env,
      auto_or_manual: 'auto',
    });
    if (histErr) {
      this.logger.warn(`[auto-tuner] history insert failed: ${histErr.message}`);
    }

    // 3. Log insight pour visibility user dashboard
    await this.insights.logInsight({
      type: 'threshold_proposal',
      source: 'auto_threshold_tuner',
      severity: env === 'prod' ? 'medium' : 'low',
      summary: `${sugg.thresholdName} ${sugg.oldValue.toFixed(3)} → ${sugg.newValue.toFixed(3)} (${sugg.reason}, env=${env})`,
      payload: {
        portfolio_id: portfolioId,
        threshold_name: sugg.thresholdName,
        old_value: sugg.oldValue,
        new_value: sugg.newValue,
        reason: sugg.reason,
        fp_rate_observed: sugg.fpRateObserved,
        failure_rate_observed: sugg.failureRateObserved,
        sample_size: sugg.sampleSize,
        applied_to_env: env,
      },
    }).catch(() => { /* non-bloquant */ });

    this.logger.log(
      `[auto-tuner] ${portfolioId.slice(0, 8)} ${sugg.thresholdName}: ${sugg.oldValue.toFixed(3)} → ${sugg.newValue.toFixed(3)} (env=${env}, reason=${sugg.reason}, n=${sugg.sampleSize})`,
    );
  }

  private async loadEnabledPortfolios(): Promise<PortfolioConfig[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('portfolio_id, gainers_auto_tuner_env, gainers_min_persistence_score, gainers_min_path_efficiency')
      .eq('gainers_auto_tuner_enabled', true)
      .eq('strategy_mode', 'gainers')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);
    if (error) {
      this.logger.warn(`[auto-tuner] loadEnabledPortfolios failed: ${error.message}`);
      return [];
    }
    return (data ?? []) as PortfolioConfig[];
  }
}
