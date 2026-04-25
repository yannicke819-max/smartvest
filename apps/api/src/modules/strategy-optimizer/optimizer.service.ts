import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import {
  DEFAULT_SEARCH_SPACE,
  DEFAULT_WEIGHTS,
  computeCompositeScore,
  evaluateAutoApply,
  expandSearchSpace,
  runSingleShot,
  runWalkForward,
  type AutoApplyState,
  type OptimizerCandidate,
  type OptimizerLeaderboard,
  type OptimizerRunMode,
  type OptimizerRunParams,
  type OptimizerRunResult,
} from '@smartvest/strategy-optimizer';
import {
  DEFAULT_UNIVERSE,
  loadUniverseHistory,
  runBacktest,
  type BacktestConfig,
  type TickerHistory,
} from '@smartvest/backtest';

/**
 * OptimizerService — orchestre les runs Phase A / B / C.
 *
 * Phase A et C : déclenchés par requête utilisateur (synchrone, ~5-30s).
 * Phase B : appelé soit par requête manuelle (dry-run), soit par cron (apply auto).
 */
@Injectable()
export class OptimizerService {
  private readonly logger = new Logger(OptimizerService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  // ─── Public entrypoints ─────────────────────────────────────────────────

  async run(userId: string, params: OptimizerRunParams): Promise<OptimizerRunResult> {
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey || apiKey === 'demo') {
      throw new BadRequestException('EODHD_API_KEY manquant — backtest impossible.');
    }

    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    const { histories, warnings } = await loadUniverseHistory(
      { fromDate: params.fromDate, toDate: params.toDate, apiKey },
      DEFAULT_UNIVERSE,
    );
    if (histories.length === 0) {
      throw new BadRequestException(
        `Aucune donnée chargée depuis EODHD pour ${params.fromDate} → ${params.toDate}.`,
      );
    }

    const space = params.searchSpace ?? DEFAULT_SEARCH_SPACE;
    const candidates = expandSearchSpace(space, params.maxCandidates);

    const baseConfig = this.buildBaseBacktestConfig(params);

    let leaderboard: OptimizerLeaderboard;
    if (params.mode === 'single_shot') {
      leaderboard = await runSingleShot({ candidates, histories, baseConfig });
    } else if (params.mode === 'walk_forward' || params.mode === 'auto_apply') {
      leaderboard = await runWalkForward({
        candidates,
        histories,
        baseConfig,
        trainRatio: params.trainRatio,
      });
    } else {
      throw new BadRequestException(`Mode inconnu : ${String(params.mode)}`);
    }

    // Phase B uniquement : évaluer la décision d'application
    let applyDecision = undefined;
    let applied = false;
    if (params.mode === 'auto_apply') {
      const state = await this.getOrCreateAutoState(userId);
      const { current, currentScore } = await this.scoreCurrentConfig(userId, histories, baseConfig);
      const decision = evaluateAutoApply({
        leaderboard,
        currentCandidate: current,
        currentScore,
        state,
      });
      applyDecision = decision;

      if (decision.willApply && decision.appliedConfig) {
        await this.applyConfigToLisa(userId, decision.appliedConfig);
        await this.markApplied(userId);
        applied = true;
      }
      await this.markRunForState(userId, 'auto_apply');
    }

    const result: OptimizerRunResult = {
      mode: params.mode,
      fromDate: params.fromDate,
      toDate: params.toDate,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      candidatesTested: candidates.length,
      leaderboard,
      ...(applyDecision ? { applyDecision } : {}),
      warnings,
    };

    await this.persistRun(userId, params, result, applied);

    return result;
  }

  async getAutoState(userId: string): Promise<AutoApplyState> {
    return this.getOrCreateAutoState(userId);
  }

  async setAutoEnabled(userId: string, enabled: boolean): Promise<AutoApplyState> {
    const state = await this.getOrCreateAutoState(userId);
    const { error } = await this.supabase.getClient()
      .from('optimizer_auto_state')
      .upsert({
        user_id: userId,
        enabled,
        last_run_at: state.lastRunAt,
        last_apply_at: state.lastApplyAt,
        last_mode: state.lastMode,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    if (error) throw new BadRequestException(error.message);
    return { ...state, enabled };
  }

  async listRuns(userId: string, limit = 20): Promise<unknown[]> {
    const { data, error } = await this.supabase.getClient()
      .from('optimizer_runs')
      .select('id, mode, from_date, to_date, candidates_tested, best_score, best_candidate, apply_decision, applied, duration_ms, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async applyCandidate(userId: string, candidate: OptimizerCandidate): Promise<void> {
    await this.applyConfigToLisa(userId, candidate);
    await this.markApplied(userId);
  }

  // ─── Helpers privés ─────────────────────────────────────────────────────

  private buildBaseBacktestConfig(params: OptimizerRunParams): Pick<
    BacktestConfig,
    | 'fromDate' | 'toDate' | 'initialCapitalUsd' | 'universe'
    | 'profile' | 'maxOpenPositions' | 'slippageBps' | 'feeBps' | 'maxHorizonDays'
  > {
    return {
      fromDate: params.fromDate,
      toDate: params.toDate,
      initialCapitalUsd: params.initialCapitalUsd,
      universe: [], // utilise DEFAULT_UNIVERSE
      profile: 'sniper_mode',
      maxOpenPositions: 12,
      slippageBps: 10,
      feeBps: 10,
      maxHorizonDays: 5,
    };
  }

  private async getOrCreateAutoState(userId: string): Promise<AutoApplyState> {
    const { data } = await this.supabase.getClient()
      .from('optimizer_auto_state')
      .select('enabled, last_run_at, last_apply_at, last_mode')
      .eq('user_id', userId)
      .maybeSingle();
    if (data) {
      return {
        enabled: Boolean(data.enabled),
        lastRunAt: (data.last_run_at as string | null) ?? null,
        lastApplyAt: (data.last_apply_at as string | null) ?? null,
        lastMode: (data.last_mode as OptimizerRunMode | null) ?? null,
      };
    }
    // Insert default
    await this.supabase.getClient()
      .from('optimizer_auto_state')
      .insert({ user_id: userId, enabled: false });
    return { enabled: false, lastRunAt: null, lastApplyAt: null, lastMode: null };
  }

  private async markRunForState(userId: string, mode: OptimizerRunMode): Promise<void> {
    const state = await this.getOrCreateAutoState(userId);
    await this.supabase.getClient()
      .from('optimizer_auto_state')
      .upsert({
        user_id: userId,
        enabled: state.enabled,
        last_run_at: new Date().toISOString(),
        last_apply_at: state.lastApplyAt,
        last_mode: mode,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
  }

  private async markApplied(userId: string): Promise<void> {
    const state = await this.getOrCreateAutoState(userId);
    const now = new Date().toISOString();
    await this.supabase.getClient()
      .from('optimizer_auto_state')
      .upsert({
        user_id: userId,
        enabled: state.enabled,
        last_run_at: now,
        last_apply_at: now,
        last_mode: state.lastMode,
        updated_at: now,
      }, { onConflict: 'user_id' });
  }

  /**
   * Récupère la config courante de Lisa pour ce user, et la rejoue sur la même
   * fenêtre que le run pour avoir une baseline comparable au best.
   */
  private async scoreCurrentConfig(
    userId: string,
    histories: TickerHistory[],
    baseConfig: ReturnType<OptimizerService['buildBaseBacktestConfig']>,
  ): Promise<{ current: OptimizerCandidate | null; currentScore: number | null }> {
    const { data: portfolio } = await this.supabase.getClient()
      .from('portfolios')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!portfolio) return { current: null, currentScore: null };

    const { data: cfg } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('anti_consensus_strength, risk_constraints')
      .eq('portfolio_id', portfolio.id)
      .maybeSingle();
    if (!cfg) return { current: null, currentScore: null };

    const rc = (cfg.risk_constraints as Record<string, unknown> | null) ?? {};
    const current: OptimizerCandidate = {
      antiConsensusStrength: Number(cfg.anti_consensus_strength ?? 5),
      maxPositionSizePct: Number(rc['maxPositionSizePct'] ?? 8),
      maxAssetClassExposurePct: Number(
        rc['maxAssetClassExposurePct'] ?? rc['maxExposurePerAssetClassPct'] ?? 20,
      ),
      stopLossPct: 2,
      takeProfitPct: 4,
    };

    const result = runBacktest({
      config: {
        ...baseConfig,
        enableOptions: false,
        defaultIv: 0.30,
        optionsDte: 14,
        strikeOtmPct: 2,
        ...current,
      },
      histories,
      warnings: [],
    });
    return { current, currentScore: computeCompositeScore(result.metrics, DEFAULT_WEIGHTS) };
  }

  private async applyConfigToLisa(userId: string, candidate: OptimizerCandidate): Promise<void> {
    const { data: portfolio } = await this.supabase.getClient()
      .from('portfolios')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!portfolio) {
      throw new BadRequestException('Aucun portfolio trouvé pour ce user — apply impossible.');
    }

    // Lit la risk_constraints courante pour ne PAS écraser les autres champs
    const { data: cfg } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('risk_constraints')
      .eq('portfolio_id', portfolio.id)
      .maybeSingle();
    const rc = (cfg?.risk_constraints as Record<string, unknown> | null) ?? {};
    const newRc = {
      ...rc,
      maxPositionSizePct: candidate.maxPositionSizePct,
      maxAssetClassExposurePct: candidate.maxAssetClassExposurePct,
    };

    const { error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .update({
        anti_consensus_strength: candidate.antiConsensusStrength,
        risk_constraints: newRc,
        updated_at: new Date().toISOString(),
      })
      .eq('portfolio_id', portfolio.id);
    if (error) throw new BadRequestException(`Apply échoué : ${error.message}`);

    this.logger.log(
      `[OPTIMIZER APPLY] user=${userId.slice(0, 8)} antiCons=${candidate.antiConsensusStrength} maxPos=${candidate.maxPositionSizePct}% maxClass=${candidate.maxAssetClassExposurePct}%`,
    );
  }

  private async persistRun(
    userId: string,
    params: OptimizerRunParams,
    result: OptimizerRunResult,
    applied: boolean,
  ): Promise<void> {
    const { error } = await this.supabase.getClient()
      .from('optimizer_runs')
      .insert({
        user_id: userId,
        mode: params.mode,
        from_date: params.fromDate,
        to_date: params.toDate,
        initial_capital_usd: params.initialCapitalUsd,
        candidates_tested: result.candidatesTested,
        best_score: result.leaderboard.best?.compositeScore ?? null,
        best_candidate: result.leaderboard.best?.candidate ?? null,
        leaderboard: result.leaderboard.ranked.slice(0, 10), // garder top 10
        warnings: result.warnings,
        duration_ms: result.durationMs,
        apply_decision: result.applyDecision ?? null,
        applied,
      });
    if (error) {
      this.logger.warn(`Optimizer persist failed: ${error.message}`);
    }
  }
}
