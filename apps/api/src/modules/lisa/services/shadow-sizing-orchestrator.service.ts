/**
 * ShadowSizingOrchestratorService — Feature shadow sizing × AI auto-tuning.
 *
 * 3 portfolios shadow `high` / `middle` / `small` créés via migration 0166 :
 *   - HIGH   : 3  positions × $3500 (concentré)
 *   - MIDDLE : 15 positions × $700  (équilibré)
 *   - SMALL  : 40 positions × $262  (diversifié)
 *
 * Cible user : $200/jour. Tous les 3 bypassent persistence (=0) et path_eff (=0)
 * mais passent dans le reste du pipeline standard (hour gate, ATR, anti-chase,
 * earnings, conviction sizing, etc.).
 *
 * Cron 30min :
 *   1. Snapshot PnL réalisé + unrealized + fees estimés par profile
 *   2. AI auto-correction (Gemini Flash Lite) :
 *      - kill-switch automatique si drawdown_today > 5%
 *      - suggestion sizing tune (ouvrir plus / moins de positions)
 *      - alerte fees (si fees > 20% du gross PnL)
 *      - target progress vs $200/jour
 *   3. Log toutes les décisions dans `shadow_sizing_autotune_log` pour audit
 *
 * Gating ENV (default OFF pour shipping safe) :
 *   SHADOW_SIZING_ORCHESTRATOR_ENABLED=true
 *
 * Best-effort : tout échec (LLM down, parse fail, query DB) → log warn,
 * pas de crash. Cron tourne tous les 30 min sans dépendance.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { LisaService } from './lisa.service';

const SHADOW_PORTFOLIOS = [
  { id: 'a0000001-0000-0000-0000-000000000001', name: 'high'   as const, posCount: 3,  posUsd: 3500 },
  { id: 'a0000002-0000-0000-0000-000000000002', name: 'middle' as const, posCount: 15, posUsd: 700  },
  { id: 'a0000003-0000-0000-0000-000000000003', name: 'small'  as const, posCount: 40, posUsd: 262  },
];

const DAILY_TARGET_USD = 200;
const DRAWDOWN_KILL_PCT = 5.0;  // auto-pause si drawdown_today > 5%
const FEES_ALERT_PCT = 20.0;    // alerte si fees > 20% du gross PnL

// Fees round-trip par asset class (entry + exit, en %)
const FEES_ROUND_TRIP_PCT: Record<string, number> = {
  'crypto_major':       0.20,  // Binance taker 0.10% × 2
  'crypto_alt':         0.20,
  'us_equity_large':    0.05,  // typical broker + SEC fee
  'us_equity_small_mid':0.05,
  'eu_equity':          0.20,  // typical EU broker
  'asia_equity':        0.20,
};

interface ProfileSnapshot {
  portfolioId: string;
  profileName: 'high' | 'middle' | 'small';
  openPositions: number;
  closedToday: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  winRatePct: number | null;
  feesPaidUsd: number;
  netPnlAfterFeesUsd: number;
  dailyPnlExtrapolatedUsd: number | null;
  targetProgressPct: number;
  drawdownTodayPct: number;
  capacityUsedPct: number;
  killSwitchActive: boolean;
}

@Injectable()
export class ShadowSizingOrchestratorService {
  private readonly logger = new Logger(ShadowSizingOrchestratorService.name);
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llmRouter: ScannerLlmRouterService,
    private readonly lisa: LisaService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('SHADOW_SIZING_ORCHESTRATOR_ENABLED') ?? 'false')
      .toLowerCase() === 'true';
    if (this.enabled) {
      this.logger.log(
        `[shadow-sizing] ENABLED — cron */30min, target=$${DAILY_TARGET_USD}/d, drawdown_kill=${DRAWDOWN_KILL_PCT}%`,
      );
    }
  }

  /**
   * Cron toutes les 30 minutes. Boucle complète :
   *   tracking → analyse IA → auto-correction → log.
   */
  @Cron('*/30 * * * *', { name: 'shadow-sizing-orchestrator', timeZone: 'UTC' })
  async runCycle(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;

    const startedAt = new Date();
    this.logger.log(`[shadow-sizing] cycle start @ ${startedAt.toISOString()}`);

    const snapshots: ProfileSnapshot[] = [];
    for (const cfg of SHADOW_PORTFOLIOS) {
      try {
        const snap = await this.snapshotProfile(cfg.id, cfg.name, cfg.posCount, cfg.posUsd);
        if (snap) {
          snapshots.push(snap);
          await this.persistSnapshot(snap);
        }
      } catch (e) {
        this.logger.warn(
          `[shadow-sizing] snapshot ${cfg.name} (${cfg.id.slice(0, 8)}) failed: ${String(e).slice(0, 150)}`,
        );
      }
    }

    if (snapshots.length === 0) {
      this.logger.warn('[shadow-sizing] no snapshots captured this cycle');
      return;
    }

    // Auto-correction par profile
    for (const snap of snapshots) {
      try {
        await this.autoTuneProfile(snap);
      } catch (e) {
        this.logger.warn(
          `[shadow-sizing] auto-tune ${snap.profileName} failed: ${String(e).slice(0, 150)}`,
        );
      }
    }

    // Analyse IA comparative (LLM si disponible)
    try {
      await this.aiComparativeAnalysis(snapshots);
    } catch (e) {
      this.logger.warn(`[shadow-sizing] AI analysis failed: ${String(e).slice(0, 150)}`);
    }

    const elapsedMs = Date.now() - startedAt.getTime();
    this.logger.log(
      `[shadow-sizing] cycle done in ${elapsedMs}ms — ${snapshots.length} profiles snapshotted`,
    );
  }

  // ====================================================================
  // STEP 1 — Snapshot du profil (PnL + fees + drawdown)
  // ====================================================================
  private async snapshotProfile(
    portfolioId: string,
    profileName: 'high' | 'middle' | 'small',
    maxPosCount: number,
    targetPosUsd: number,
  ): Promise<ProfileSnapshot | null> {
    const client = this.supabase.getClient();
    const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;

    // Open positions
    const { data: openPos } = await client
      .from('lisa_positions')
      .select('id, symbol, asset_class, direction, entry_price, entry_notional_usd, entry_timestamp')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');
    const openCount = openPos?.length ?? 0;

    // Compute unrealized PnL en parallèle (best-effort, fallback 0 si fail)
    let unrealizedPnl = 0;
    for (const p of openPos ?? []) {
      try {
        const live = await this.lisa.getLivePrice(p.symbol);
        if (live && live.price && !String(live.source ?? '').startsWith('fallback') && !String(live.source ?? '').startsWith('stale_')) {
          const livePx = Number(live.price);
          const entryPx = Number(p.entry_price);
          const notional = Number(p.entry_notional_usd ?? 0);
          if (Number.isFinite(livePx) && livePx > 0 && Number.isFinite(entryPx) && entryPx > 0) {
            const sign = p.direction === 'short' ? -1 : 1;
            const pctMove = sign * (livePx - entryPx) / entryPx;
            unrealizedPnl += pctMove * notional;
          }
        }
      } catch { /* skip */ }
    }

    // Closed today
    const { data: closedToday } = await client
      .from('lisa_positions')
      .select('asset_class, realized_pnl_usd, entry_notional_usd, exit_reason')
      .eq('portfolio_id', portfolioId)
      .gte('closed_at', todayStart)
      .neq('status', 'open');

    const closedCount = closedToday?.length ?? 0;
    let realized = 0;
    let wins = 0;
    let feesPaid = 0;
    for (const c of closedToday ?? []) {
      const pnl = Number(c.realized_pnl_usd ?? 0);
      realized += pnl;
      if (pnl > 0) wins++;
      // Fees estimés = notional × round_trip_pct
      const notional = Number(c.entry_notional_usd ?? 0);
      const feesPct = FEES_ROUND_TRIP_PCT[c.asset_class as string] ?? 0.15;
      feesPaid += (notional * feesPct) / 100;
    }
    const winRate = closedCount > 0 ? (wins / closedCount) * 100 : null;

    const totalPnl = realized + unrealizedPnl;
    const netPnl = totalPnl - feesPaid;

    // Drawdown = perte cumulée depuis matin si négatif
    const drawdownPct = realized < 0 ? Math.abs((realized / 10500) * 100) : 0;

    // Extrapolation daily PnL (linéaire depuis maintenant)
    const nowUtc = new Date();
    const minutesElapsedToday = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();
    const dailyExtrapolated = minutesElapsedToday > 60
      ? (netPnl / minutesElapsedToday) * 1440  // projection sur 24h
      : null;

    const capacityUsedPct = (openCount / maxPosCount) * 100;
    const targetProgressPct = (netPnl / DAILY_TARGET_USD) * 100;

    // Read kill switch state
    const { data: cfgRow } = await client
      .from('lisa_session_configs')
      .select('kill_switch_active')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    return {
      portfolioId,
      profileName,
      openPositions: openCount,
      closedToday: closedCount,
      realizedPnlUsd: Number(realized.toFixed(2)),
      unrealizedPnlUsd: Number(unrealizedPnl.toFixed(2)),
      totalPnlUsd: Number(totalPnl.toFixed(2)),
      winRatePct: winRate !== null ? Number(winRate.toFixed(2)) : null,
      feesPaidUsd: Number(feesPaid.toFixed(2)),
      netPnlAfterFeesUsd: Number(netPnl.toFixed(2)),
      dailyPnlExtrapolatedUsd: dailyExtrapolated !== null ? Number(dailyExtrapolated.toFixed(2)) : null,
      targetProgressPct: Number(targetProgressPct.toFixed(2)),
      drawdownTodayPct: Number(drawdownPct.toFixed(2)),
      capacityUsedPct: Number(capacityUsedPct.toFixed(2)),
      killSwitchActive: cfgRow?.kill_switch_active === true,
    };
  }

  private async persistSnapshot(snap: ProfileSnapshot): Promise<void> {
    const { error } = await this.supabase.getClient()
      .from('shadow_sizing_snapshot')
      .insert({
        portfolio_id: snap.portfolioId,
        profile_name: snap.profileName,
        open_positions: snap.openPositions,
        closed_today: snap.closedToday,
        realized_pnl_usd: snap.realizedPnlUsd,
        unrealized_pnl_usd: snap.unrealizedPnlUsd,
        total_pnl_usd: snap.totalPnlUsd,
        win_rate_pct: snap.winRatePct,
        fees_paid_usd: snap.feesPaidUsd,
        net_pnl_after_fees_usd: snap.netPnlAfterFeesUsd,
        daily_pnl_extrapolated_usd: snap.dailyPnlExtrapolatedUsd,
        target_progress_pct: snap.targetProgressPct,
        drawdown_today_pct: snap.drawdownTodayPct,
        capacity_used_pct: snap.capacityUsedPct,
      });
    if (error) {
      this.logger.warn(`[shadow-sizing] persist snap ${snap.profileName} failed: ${error.message}`);
    } else {
      this.logger.log(
        `[shadow-sizing] ${snap.profileName.padEnd(6)} snap : open=${snap.openPositions}/${snap.openPositions + snap.closedToday} ` +
        `realized=$${snap.realizedPnlUsd} unreal=$${snap.unrealizedPnlUsd} fees=$${snap.feesPaidUsd} ` +
        `net=$${snap.netPnlAfterFeesUsd} (target=${snap.targetProgressPct}%) drawdown=${snap.drawdownTodayPct}%`,
      );
    }
  }

  // ====================================================================
  // STEP 2 — Auto-correction par profile (règles dures)
  // ====================================================================
  private async autoTuneProfile(snap: ProfileSnapshot): Promise<void> {
    // Règle 1 : Kill-switch automatique si drawdown > seuil
    if (snap.drawdownTodayPct > DRAWDOWN_KILL_PCT && !snap.killSwitchActive) {
      await this.applyKillSwitch(snap.portfolioId, snap.profileName, snap.drawdownTodayPct);
      return;  // pas de suite si on kill
    }

    // Règle 2 : Restart après pause si drawdown < 2% ET kill_switch actif
    if (snap.killSwitchActive && snap.drawdownTodayPct < 2.0) {
      await this.restartAfterPause(snap.portfolioId, snap.profileName, snap.drawdownTodayPct);
      return;
    }

    // Règle 3 : Alerte fees si fees > 20% du gross PnL positif
    if (snap.totalPnlUsd > 0 && snap.feesPaidUsd / snap.totalPnlUsd > FEES_ALERT_PCT / 100) {
      await this.logAutoTune({
        portfolioId: snap.portfolioId,
        profileName: snap.profileName,
        decisionKind: 'fees_alert',
        triggerMetric: 'fees_ratio',
        triggerValue: (snap.feesPaidUsd / snap.totalPnlUsd) * 100,
        thresholdValue: FEES_ALERT_PCT,
        actionApplied: false,
        rationale: `Fees $${snap.feesPaidUsd} = ${((snap.feesPaidUsd / snap.totalPnlUsd) * 100).toFixed(1)}% du gross PnL $${snap.totalPnlUsd}. Sizing trop petit pour amortir les frais.`,
        payload: { snap },
      });
    }

    // Règle 4 : Target progress log (chaque cycle)
    await this.logAutoTune({
      portfolioId: snap.portfolioId,
      profileName: snap.profileName,
      decisionKind: 'target_progress',
      triggerMetric: 'net_pnl_today',
      triggerValue: snap.netPnlAfterFeesUsd,
      thresholdValue: DAILY_TARGET_USD,
      actionApplied: false,
      rationale: `Profile ${snap.profileName}: net $${snap.netPnlAfterFeesUsd}/$${DAILY_TARGET_USD} (${snap.targetProgressPct}%). Extrapolated daily: $${snap.dailyPnlExtrapolatedUsd ?? 'n/a'}.`,
      payload: { snap },
    });
  }

  private async applyKillSwitch(
    portfolioId: string,
    profileName: string,
    drawdownPct: number,
  ): Promise<void> {
    const { error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .update({ kill_switch_active: true, autopilot_paused_reason: 'SHADOW_DRAWDOWN_KILL' })
      .eq('portfolio_id', portfolioId);

    await this.logAutoTune({
      portfolioId,
      profileName,
      decisionKind: 'kill_switch_drawdown',
      triggerMetric: 'drawdown_today_pct',
      triggerValue: drawdownPct,
      thresholdValue: DRAWDOWN_KILL_PCT,
      actionApplied: !error,
      rationale: error
        ? `Kill-switch tentative FAILED (${error.message})`
        : `🛑 KILL-SWITCH activé : drawdown ${drawdownPct.toFixed(2)}% > ${DRAWDOWN_KILL_PCT}%. Profile ${profileName} paused.`,
      payload: { error: error?.message },
    });

    this.logger.warn(
      `[shadow-sizing] 🛑 KILL-SWITCH ${profileName} (${portfolioId.slice(0, 8)}) — drawdown=${drawdownPct.toFixed(2)}%`,
    );
  }

  private async restartAfterPause(
    portfolioId: string,
    profileName: string,
    drawdownPct: number,
  ): Promise<void> {
    const { error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .update({ kill_switch_active: false, autopilot_paused_reason: null })
      .eq('portfolio_id', portfolioId);

    await this.logAutoTune({
      portfolioId,
      profileName,
      decisionKind: 'restart_after_pause',
      triggerMetric: 'drawdown_today_pct',
      triggerValue: drawdownPct,
      thresholdValue: 2.0,
      actionApplied: !error,
      rationale: error
        ? `Restart tentative FAILED (${error.message})`
        : `✅ RESTART : drawdown ${drawdownPct.toFixed(2)}% < 2%. Profile ${profileName} resumed.`,
      payload: { error: error?.message },
    });

    this.logger.log(
      `[shadow-sizing] ✅ RESTART ${profileName} (${portfolioId.slice(0, 8)}) — drawdown=${drawdownPct.toFixed(2)}%`,
    );
  }

  // ====================================================================
  // STEP 3 — AI comparative analysis (Gemini Flash Lite via LLM router)
  // ====================================================================
  private async aiComparativeAnalysis(snapshots: ProfileSnapshot[]): Promise<void> {
    if (!this.llmRouter.isEnabled()) {
      // Fallback déterministe : log le winner
      const winner = snapshots.reduce((best, cur) =>
        cur.netPnlAfterFeesUsd > best.netPnlAfterFeesUsd ? cur : best
      );
      await this.logAutoTune({
        portfolioId: winner.portfolioId,
        profileName: winner.profileName,
        decisionKind: 'sizing_suggestion',
        triggerMetric: 'comparative_winner',
        triggerValue: winner.netPnlAfterFeesUsd,
        thresholdValue: 0,
        actionApplied: false,
        rationale: `Winner this cycle = ${winner.profileName} ($${winner.netPnlAfterFeesUsd} net). LLM router OFF, suggestion déterministe only.`,
        payload: { snapshots },
      });
      return;
    }

    // LLM router enabled — pour l'instant on log juste la comparaison
    // (vrai prompt LLM est follow-up : on génère une suggestion sizing tune)
    const summary = snapshots.map(s =>
      `${s.profileName}: open=${s.openPositions}, closed=${s.closedToday}, net=$${s.netPnlAfterFeesUsd}, drawdown=${s.drawdownTodayPct}%, target=${s.targetProgressPct}%`
    ).join(' | ');
    this.logger.log(`[shadow-sizing] comparative: ${summary}`);

    const winner = snapshots.reduce((best, cur) =>
      cur.netPnlAfterFeesUsd > best.netPnlAfterFeesUsd ? cur : best
    );
    await this.logAutoTune({
      portfolioId: winner.portfolioId,
      profileName: winner.profileName,
      decisionKind: 'sizing_suggestion',
      triggerMetric: 'comparative_winner',
      triggerValue: winner.netPnlAfterFeesUsd,
      thresholdValue: 0,
      actionApplied: false,
      rationale: `🏆 Winner cycle = ${winner.profileName} ($${winner.netPnlAfterFeesUsd} net). Comparative: ${summary}`,
      payload: { snapshots },
    });
  }

  private async logAutoTune(row: {
    portfolioId: string;
    profileName: string;
    decisionKind: string;
    triggerMetric: string;
    triggerValue: number;
    thresholdValue: number;
    actionApplied: boolean;
    rationale: string;
    payload?: unknown;
  }): Promise<void> {
    const { error } = await this.supabase.getClient()
      .from('shadow_sizing_autotune_log')
      .insert({
        portfolio_id: row.portfolioId,
        profile_name: row.profileName,
        decision_kind: row.decisionKind,
        trigger_metric: row.triggerMetric,
        trigger_value: row.triggerValue,
        threshold_value: row.thresholdValue,
        action_applied: row.actionApplied,
        rationale: row.rationale,
        payload: row.payload as object,
      });
    if (error) {
      this.logger.warn(`[shadow-sizing] log auto-tune failed: ${error.message}`);
    }
  }

  // ====================================================================
  // PUBLIC API — utilisée par /admin/shadow-sizing/status
  // ====================================================================
  async getLatestStatus(): Promise<{
    enabled: boolean;
    target_usd_per_day: number;
    profiles: Array<{
      profile_name: string;
      portfolio_id: string;
      latest_snapshot: object | null;
      latest_decisions: object[];
    }>;
  }> {
    const result = {
      enabled: this.enabled,
      target_usd_per_day: DAILY_TARGET_USD,
      profiles: [] as Array<{
        profile_name: string;
        portfolio_id: string;
        latest_snapshot: object | null;
        latest_decisions: object[];
      }>,
    };

    for (const cfg of SHADOW_PORTFOLIOS) {
      const { data: snap } = await this.supabase.getClient()
        .from('shadow_sizing_snapshot')
        .select('*')
        .eq('portfolio_id', cfg.id)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: decisions } = await this.supabase.getClient()
        .from('shadow_sizing_autotune_log')
        .select('*')
        .eq('portfolio_id', cfg.id)
        .order('decided_at', { ascending: false })
        .limit(5);

      result.profiles.push({
        profile_name: cfg.name,
        portfolio_id: cfg.id,
        latest_snapshot: snap ?? null,
        latest_decisions: (decisions ?? []) as object[],
      });
    }
    return result;
  }
}
