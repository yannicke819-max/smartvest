/**
 * FeatureABTuningService — Miracle #4.
 *
 * 2 crons :
 *   - 00:30 UTC daily : SNAPSHOT (état flags + PnL du jour passé)
 *   - 02:00 UTC daily : ANALYZE (compute contributions sur les 14 derniers jours,
 *                                log narrative + persiste verdicts dans decision_log)
 *
 * Default OFF. Aucun changement automatique des flags Fly — la machine OBSERVE
 * et RECOMMANDE, le user décide via fly secrets set/unset.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { DecisionLogService } from './decision-log.service';
import {
  computeFeatureContributions,
  buildNarrative,
  type DailySnapshot,
} from './feature-ab-tuning.helper';

// Liste des flags qu'on tracke. Ajouter ici tout nouveau flag à mesurer.
const TRACKED_FLAGS: string[] = [
  'RISK_MONITOR_ENABLED',
  'RISK_MONITOR_GEMINI_ENABLED',
  'CORRELATION_GUARD_ENABLED',
  'CONVICTION_SIZING_ENABLED',
  'DAILY_RETROSPECTIVE_ENABLED',
  'ADAPTIVE_COOLDOWN_ENABLED',
  'REVERSE_MOMENTUM_MODE',          // valeurs : long_only / short_only / both
  'MICRO_MOMENTUM_GATE_ENABLED',
  'EARLY_EXIT_GUARD_ENABLED',
];

@Injectable()
export class FeatureABTuningService {
  private readonly logger = new Logger(FeatureABTuningService.name);
  private enabled = false;
  private windowDays = 14;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly decisionLog: DecisionLogService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('FEATURE_AB_TUNING_ENABLED') ?? 'false').toLowerCase() === 'true';
    const wdRaw = Number.parseInt(this.config.get<string>('FEATURE_AB_WINDOW_DAYS') ?? '', 10);
    this.windowDays = Number.isFinite(wdRaw) && wdRaw >= 3 && wdRaw <= 90 ? wdRaw : 14;
    if (this.enabled) {
      this.logger.log(
        `[feature-ab] ENABLED — snapshot daily 00:30 UTC, analyze 02:00 UTC, window=${this.windowDays}j, tracking ${TRACKED_FLAGS.length} flags`,
      );
    }
  }

  /** Cron daily 00:30 UTC — snapshot l'état des flags + PnL du jour passé. */
  @Cron('30 0 * * *', { name: 'feature-ab-snapshot', timeZone: 'UTC' })
  async cronSnapshot(): Promise<void> {
    if (!this.enabled || !this.supabase.isReady()) return;
    try {
      const portfolios = await this.fetchActivePortfolios();
      const yesterday = new Date();
      yesterday.setUTCHours(0, 0, 0, 0);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const dateStr = yesterday.toISOString().slice(0, 10);
      for (const p of portfolios) {
        await this.snapshotForPortfolio(p.id, dateStr).catch((e) =>
          this.logger.warn(`[feature-ab] snapshot portfolio ${p.id.slice(0, 8)} failed: ${String(e).slice(0, 150)}`),
        );
      }
    } catch (e) {
      this.logger.error(`[feature-ab] cronSnapshot exception: ${String(e).slice(0, 300)}`);
    }
  }

  /** Cron daily 02:00 UTC — analyze contributions sur la fenêtre glissante. */
  @Cron('0 2 * * *', { name: 'feature-ab-analyze', timeZone: 'UTC' })
  async cronAnalyze(): Promise<void> {
    if (!this.enabled || !this.supabase.isReady()) return;
    try {
      const portfolios = await this.fetchActivePortfolios();
      for (const p of portfolios) {
        await this.analyzeForPortfolio(p.id).catch((e) =>
          this.logger.warn(`[feature-ab] analyze portfolio ${p.id.slice(0, 8)} failed: ${String(e).slice(0, 150)}`),
        );
      }
    } catch (e) {
      this.logger.error(`[feature-ab] cronAnalyze exception: ${String(e).slice(0, 300)}`);
    }
  }

  private async fetchActivePortfolios(): Promise<Array<{ id: string }>> {
    const { data, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('portfolio_id, autopilot_enabled, kill_switch_active')
      .eq('autopilot_enabled', true)
      .neq('kill_switch_active', true);
    if (error) {
      this.logger.warn(`[feature-ab] fetch portfolios: ${error.message}`);
      return [];
    }
    return ((data ?? []) as Array<{ portfolio_id: string }>).map((r) => ({ id: r.portfolio_id }));
  }

  /**
   * Snapshot l'état flags + PnL du jour `dateStr` (typiquement la veille).
   * Idempotent grâce à UNIQUE(portfolio_id, snapshot_date).
   */
  async snapshotForPortfolio(portfolioId: string, dateStr: string): Promise<{ inserted: boolean; reason?: string }> {
    // 1. Flags state (lecture ENV via ConfigService)
    const flags: Record<string, boolean> = {};
    for (const flag of TRACKED_FLAGS) {
      const v = (this.config.get<string>(flag) ?? '').toLowerCase().trim();
      if (flag === 'REVERSE_MOMENTUM_MODE') {
        flags[flag] = v === 'short_only' || v === 'both';
      } else {
        flags[flag] = v === 'true';
      }
    }

    // 2. Closes du jour (date UTC)
    const dayStart = `${dateStr}T00:00:00Z`;
    const dayEnd = new Date(new Date(dayStart).getTime() + 86400_000).toISOString();
    const { data: closes } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('realized_pnl_usd, status')
      .eq('portfolio_id', portfolioId)
      .gte('exit_timestamp', dayStart)
      .lt('exit_timestamp', dayEnd)
      .neq('status', 'open');

    const closedRows = ((closes ?? []) as Array<{ realized_pnl_usd: number | null; status: string }>)
      .filter((c) => c.realized_pnl_usd != null);
    const pnl = closedRows.reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0);
    const winners = closedRows.filter((c) => Number(c.realized_pnl_usd ?? 0) > 0).length;
    const losers = closedRows.filter((c) => Number(c.realized_pnl_usd ?? 0) < 0).length;

    // 3. n_opens
    const { count: nOpens } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .gte('entry_timestamp', dayStart)
      .lt('entry_timestamp', dayEnd);

    // 4. counts d'actions risk_monitor + correlation + early_exit (via decision_log)
    const { data: dlogs } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('kind, payload')
      .eq('portfolio_id', portfolioId)
      .eq('kind', 'risk_monitor_action')
      .gte('created_at', dayStart)
      .lt('created_at', dayEnd);
    let rmActions = 0; let cgRejections = 0; let eeFades = 0;
    for (const log of (dlogs ?? []) as Array<{ payload: { verdict?: string; early_exit?: boolean; correlation_reject?: boolean } }>) {
      const v = log.payload?.verdict;
      if (v === 'EARLY_EXIT_FADE' || log.payload?.early_exit) eeFades++;
      else if (log.payload?.correlation_reject) cgRejections++;
      else rmActions++;
    }

    // 5. UPSERT
    const { error } = await this.supabase.getClient()
      .from('feature_ab_snapshot')
      .upsert({
        snapshot_date: dateStr,
        portfolio_id: portfolioId,
        flags_json: flags,
        pnl_usd: Math.round(pnl * 100) / 100,
        n_opens: nOpens ?? 0,
        n_closes: closedRows.length,
        n_winners: winners,
        n_losers: losers,
        rm_actions_count: rmActions,
        cg_rejections_count: cgRejections,
        ee_fades_count: eeFades,
      }, { onConflict: 'portfolio_id,snapshot_date' });
    if (error) return { inserted: false, reason: error.message };
    this.logger.log(
      `[feature-ab] snapshot ${portfolioId.slice(0, 8)} ${dateStr} pnl=$${pnl.toFixed(2)} (${winners}W/${losers}L) opens=${nOpens ?? 0} rm=${rmActions} ee=${eeFades}`,
    );
    return { inserted: true };
  }

  /**
   * Analyse sliding window N derniers jours, persiste verdicts dans decision_log.
   */
  async analyzeForPortfolio(portfolioId: string): Promise<{ contributions_count: number; narrative: string }> {
    const since = new Date(Date.now() - this.windowDays * 86400_000).toISOString().slice(0, 10);
    const { data, error } = await this.supabase.getClient()
      .from('feature_ab_snapshot')
      .select('snapshot_date, pnl_usd, flags_json, n_closes')
      .eq('portfolio_id', portfolioId)
      .gte('snapshot_date', since)
      .order('snapshot_date', { ascending: true });
    if (error) {
      this.logger.warn(`[feature-ab] fetch snapshots: ${error.message}`);
      return { contributions_count: 0, narrative: 'fetch failed' };
    }
    const snapshots: DailySnapshot[] = ((data ?? []) as Array<{
      snapshot_date: string; pnl_usd: number | null; flags_json: Record<string, boolean>; n_closes: number | null;
    }>).map((r) => ({
      date: r.snapshot_date,
      pnl_usd: Number(r.pnl_usd ?? 0),
      flags: r.flags_json ?? {},
      n_closes: Number(r.n_closes ?? 0),
    }));

    const contributions = computeFeatureContributions(snapshots);
    const narrative = buildNarrative(contributions);
    this.logger.log(`[feature-ab] ${portfolioId.slice(0, 8)} analyze ${snapshots.length} snapshots :\n${narrative}`);

    // Persiste verdicts dans decision_log
    await this.decisionLog.append({
      portfolioId,
      kind: 'risk_monitor_action',
      summary: `[FEATURE_AB] window=${snapshots.length}j analyse de ${contributions.length} flags`,
      rationale: narrative.slice(0, 1500),
      payload: {
        feature_ab_analysis: true,
        window_days: this.windowDays,
        snapshots_count: snapshots.length,
        contributions,
      },
      triggeredBy: 'autopilot_cron',
    }).catch(() => { /* swallow */ });

    return { contributions_count: contributions.length, narrative };
  }
}
