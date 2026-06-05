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

interface GeminiDecision {
  action_kind: 'kill' | 'restart' | 'raise_sizing' | 'lower_sizing' | 'tune_tp_sl' | 'no_action';
  target_profile: 'high' | 'middle' | 'small' | null;
  params?: {
    new_position_pct?: number;
    new_max_open?: number;
    new_tp_pct?: number;
    new_sl_pct?: number;
  };
  confidence: number;  // 0.0-1.0
  rationale: string;
}

const SHADOW_SIZING_GEMINI_SYSTEM_PROMPT = `Tu es un agent IA de risk management pour 3 portfolios paper-trading "shadow sizing" qui benchmarkent l'effet du sizing sur la même watchlist :
- "high" : 3 positions × ~$3500 (concentré)
- "middle" : 15 positions × ~$700 (équilibré)
- "small" : 40 positions × ~$262 (diversifié)

Ton job : analyser les snapshots toutes les 30 min et décider d'UNE action concrète pour maximiser P&L net après fees, avec cible $200/jour.

Actions possibles (action_kind):
- "kill" : mettre en pause un profile (kill_switch_active=true) si drawdown_today > 5% ou expectancy clairement -EV
- "restart" : reprendre un profile en pause si drawdown < 2%
- "raise_sizing" : augmenter position_pct ou max_open si le profile out-performe et a de la capacity libre (max +20%/cycle)
- "lower_sizing" : diminuer si under-performance OR fees > 20% du gross PnL (sizing trop petit)
- "tune_tp_sl" : ajuster gainers_default_tp_pct (0.1-10) / gainers_default_sl_pct (0.1-10) selon win_rate observé
- "no_action" : laisser tourner, contexte trop early ou état OK

CONTRAINTES :
- N'agis QUE si confidence ≥ 0.7 (sinon retourne no_action)
- Changements sizing capés à ±20% par cycle automatiquement
- Privilégie kill > restart > tune > sizing en cas de doute (gestion du risque d'abord)
- N'utilise PAS de connaissances externes — base tes décisions UNIQUEMENT sur les data fournies

CONTEXTE MACRO (input \`macro\`) :
- Pondère tes décisions selon le régime : VIX > 25 = risk-off, agressivité kill ↑ / raise_sizing ↓
- DXY spike + US10Y > 4.5% = pressure sur risk assets, prudence
- Si \`macro.dataQuality.fallback\` non vide → indicateurs dégradés, baisse ta confidence de 0.1

CONTEXTE NEWS (input \`macro_news_digest\`, top 10 tier-1 dernières 2h) :
- Sert UNIQUEMENT à contextualiser le régime narratif (pas à trader des tickers individuels)
- Exemple : "5 news Fed pivot positifs + 2 news bank stress négatifs" → régime mixte, pas de raise_sizing
- Si digest vide ou tous sentiment ~0 → marché calme, conditions normales
- Ne cite pas les titres dans ta rationale (trop verbeux), mais réfère au régime narratif synthétisé

RÉPONSE OBLIGATOIRE :
Renvoie UN SEUL objet JSON minimal (pas de markdown, pas de \\\`\\\`\\\`json) avec cette shape exacte :
{
  "action_kind": "kill"|"restart"|"raise_sizing"|"lower_sizing"|"tune_tp_sl"|"no_action",
  "target_profile": "high"|"middle"|"small"|null,
  "params": { "new_position_pct"?: number, "new_max_open"?: number, "new_tp_pct"?: number, "new_sl_pct"?: number },
  "confidence": 0.0-1.0,
  "rationale": "1-3 phrases factuelles citant les chiffres pertinents"
}

EXEMPLES de bons rationale :
- "small a fees_ratio 35% (≥20% threshold), avg_pnl_per_trade $0.50, sizing trop petit. Lower max_open de 20→12 pour augmenter notional per trade."
- "high drawdown 5.2% > 5% kill threshold après 3 cycles consecutive -PnL. Kill maintenant pour protéger capital."
- "middle target_progress 87% sur 4h, win_rate 70%, capacity 60% used. Garder, no_action."
`;

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
    const raw = this.config.get<string>('SHADOW_SIZING_ORCHESTRATOR_ENABLED');
    const rawGem = this.config.get<string>('SHADOW_SIZING_GEMINI_ENABLED');
    this.enabled = (raw ?? 'false').toLowerCase() === 'true';
    this.logger.log(
      `[shadow-sizing] onModuleInit fired — SHADOW_SIZING_ORCHESTRATOR_ENABLED raw="${raw}" parsed_enabled=${this.enabled} | SHADOW_SIZING_GEMINI_ENABLED raw="${rawGem}"`,
    );
    // PREUVE DB sentinel : écrit une row shadow_sizing_autotune_log au boot.
    this.writeBootSentinel(raw, rawGem).catch(() => null);
    if (this.enabled) {
      this.logger.log(
        `[shadow-sizing] ENABLED — cron */5min, target=$${DAILY_TARGET_USD}/d, drawdown_kill=${DRAWDOWN_KILL_PCT}%`,
      );
    }
  }

  private async writeBootSentinel(raw: string | undefined, rawGem: string | undefined): Promise<void> {
    if (!this.supabase.isReady()) return;
    const now = new Date();
    await this.supabase.getClient().from('shadow_sizing_autotune_log').insert({
      portfolio_id: SHADOW_PORTFOLIOS[0].id,
      profile_name: 'boot_sentinel',
      decision_kind: 'no_action',
      trigger_metric: 'boot_sentinel',
      trigger_value: 0,
      threshold_value: 0,
      action_applied: false,
      rationale: `[BOOT_SENTINEL] onModuleInit fired @ ${now.toISOString()} — ORCH raw="${raw}" parsed=${this.enabled} | GEM raw="${rawGem}"`,
      payload: { boot_sentinel: true, raw_flag: raw, raw_gem: rawGem, parsed_enabled: this.enabled },
    });
  }

  /**
   * Cron toutes les 5 minutes (cadence alignée avec Trader Agent).
   * Boucle complète : tracking → analyse IA → auto-correction → log.
   * Coût LLM : ~$0.03/jour (288 calls × Gemini Flash Lite).
   */
  @Cron('*/5 * * * *', { name: 'shadow-sizing-orchestrator', timeZone: 'UTC' })
  async runCycle(): Promise<void> {
    // Log inconditionnel chaque tick.
    this.logger.log(`[shadow-sizing] cron tick @ ${new Date().toISOString()} enabled=${this.enabled} supabase=${this.supabase.isReady()}`);
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

    // Gemini-driven decision : appel LLM avec snapshot + historique → action concrète
    // Gated par SHADOW_SIZING_GEMINI_ENABLED=true (default OFF, sécurité MVP)
    try {
      await this.geminiDrivenAutoCorrection(snapshots);
    } catch (e) {
      this.logger.warn(`[shadow-sizing] Gemini auto-correction failed: ${String(e).slice(0, 150)}`);
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
      .gte('exit_timestamp', todayStart)
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

    // Read kill switch state + capital_usd (denom drawdown).
    const { data: cfgRow } = await client
      .from('lisa_session_configs')
      .select('kill_switch_active, capital_usd')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    // Bug fix 05/06 : drawdownPct calculait `realized / 10500` (denom hardcoded
    // valeur shadow nominale d'origine). HIGH portfolio a depuis été upgradé à
    // $150k (oversold mode) → toute perte > -$525 sur HIGH déclenchait faussement
    // un kill drawdown > 5%. Désormais on utilise capital_usd réel.
    const capitalForDenom = Number(cfgRow?.capital_usd ?? 10500);
    const denom = Number.isFinite(capitalForDenom) && capitalForDenom > 0 ? capitalForDenom : 10500;
    const drawdownPct = realized < 0 ? Math.abs((realized / denom) * 100) : 0;

    // Extrapolation daily PnL (linéaire depuis maintenant)
    const nowUtc = new Date();
    const minutesElapsedToday = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();
    const dailyExtrapolated = minutesElapsedToday > 60
      ? (netPnl / minutesElapsedToday) * 1440  // projection sur 24h
      : null;

    const capacityUsedPct = (openCount / maxPosCount) * 100;
    const targetProgressPct = (netPnl / DAILY_TARGET_USD) * 100;

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
  // STEP 4 — Gemini-driven auto-correction (LLM dans la boucle)
  // ====================================================================
  //
  // Chaque cycle 30min, on envoie à Gemini Flash Lite :
  //   - les 3 snapshots actuels (PnL, fees, drawdown, target_progress)
  //   - les 5 dernières décisions auto-tuner par profile
  //   - l'historique 6h des snapshots (12 cycles)
  //
  // Gemini retourne une action JSON structurée avec confidence. On applique
  // SEULEMENT si confidence ≥ MIN_CONFIDENCE_TO_APPLY (default 0.7) ET
  // dans les bornes de sécurité (sizing change ≤20% par cycle, TP/SL clamp).
  //
  // Actions possibles :
  //   - kill: pause un profile (kill_switch_active=true)
  //   - restart: reprend un profile (kill_switch_active=false)
  //   - raise_sizing: augmente position_pct ou max_open
  //   - lower_sizing: diminue position_pct ou max_open
  //   - tune_tp_sl: ajuste gainers_default_tp_pct / gainers_default_sl_pct
  //   - no_action: rien (log "Gemini said hold")
  //
  // Tous les changements sont :
  //   1. Bornés par les limites DB (max_open ≤ 50, position_pct 1-100, TP 0.1-50, SL 0.1-20)
  //   2. Capés par cycle (delta sizing ≤ 20%)
  //   3. Logués dans shadow_sizing_autotune_log (decision_kind='gemini_auto_apply')
  //
  /**
   * Macro news digest pour le contexte de raisonnement Gemini auto-tune.
   *
   * Filtre :
   *  - dernières 2h (window de fraîcheur narratif)
   *  - sources tier-1 uniquement (reuters, bloomberg, cnbc, marketwatch, wsj, ft)
   *  - sentiment fort (|polarity| ≥ 0.5)
   *  - dédupliqué par title (même article = plusieurs tickers dans la table)
   *  - top 10 par |sentiment| × recency
   *
   * Best-effort : retourne `[]` si fail.
   */
  private async fetchMacroNewsDigest(): Promise<Array<{ title: string; sentiment: number; source: string; published_at: string; tags: string[] }>> {
    const TIER_1_HOSTS = [
      'reuters.com', 'bloomberg.com', 'cnbc.com', 'marketwatch.com',
      'wsj.com', 'ft.com', 'nasdaq.com', 'finance.yahoo.com',
    ];
    const sinceIso = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    try {
      const { data } = await this.supabase.getClient()
        .from('eodhd_news_articles')
        .select('title, sentiment_polarity, source_url, published_at, tags')
        .gte('published_at', sinceIso)
        .order('published_at', { ascending: false })
        .limit(150);  // fetch large pour dédup, filter ensuite
      if (!data || data.length === 0) return [];

      // Filter + extract host + dédup
      const seenTitles = new Set<string>();
      const out: Array<{ title: string; sentiment: number; source: string; published_at: string; tags: string[] }> = [];
      for (const r of data) {
        const title = String(r.title ?? '').trim();
        if (!title || seenTitles.has(title)) continue;
        const sent = Number(r.sentiment_polarity);
        if (!Number.isFinite(sent) || Math.abs(sent) < 0.5) continue;
        const host = (String(r.source_url ?? '').match(/\/\/([^/]+)/)?.[1] ?? '').toLowerCase();
        if (!TIER_1_HOSTS.some((h) => host.includes(h))) continue;
        seenTitles.add(title);
        const tags = Array.isArray(r.tags) ? (r.tags as string[]).slice(0, 5) : [];
        out.push({
          title: title.slice(0, 140),
          sentiment: Number(sent.toFixed(2)),
          source: host,
          published_at: String(r.published_at).slice(0, 16),
          tags,
        });
        if (out.length >= 10) break;
      }
      return out;
    } catch (e) {
      this.logger.warn(`[shadow-sizing-gemini] news digest fetch failed: ${String(e).slice(0, 100)}`);
      return [];
    }
  }

  // Gated par SHADOW_SIZING_GEMINI_ENABLED=true (default OFF — safe MVP).
  // Si false, la méthode no-op silencieusement.
  private async geminiDrivenAutoCorrection(snapshots: ProfileSnapshot[]): Promise<void> {
    const enabled = (this.config.get<string>('SHADOW_SIZING_GEMINI_ENABLED') ?? 'false')
      .toLowerCase() === 'true';
    if (!enabled) return;
    if (!this.llmRouter.isEnabled()) {
      this.logger.warn('[shadow-sizing-gemini] LLM router disabled — skip Gemini step');
      return;
    }

    // Historique 6h (12 derniers cycles)
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    const { data: history } = await this.supabase.getClient()
      .from('shadow_sizing_snapshot')
      .select('captured_at, profile_name, total_pnl_usd, net_pnl_after_fees_usd, drawdown_today_pct, open_positions')
      .gte('captured_at', sixHoursAgo)
      .order('captured_at', { ascending: true });

    // 5 dernières décisions par profile
    const recentDecisions: Record<string, object[]> = {};
    for (const snap of snapshots) {
      const { data: decisions } = await this.supabase.getClient()
        .from('shadow_sizing_autotune_log')
        .select('decided_at, decision_kind, rationale, action_applied')
        .eq('portfolio_id', snap.portfolioId)
        .order('decided_at', { ascending: false })
        .limit(5);
      recentDecisions[snap.profileName] = (decisions ?? []) as object[];
    }

    // Macro context (cache 2 min côté LisaService — partagé avec LiveTraderAgent).
    // Critique pour contextualiser les décisions kill/raise/lower (un drawdown en VIX 35
    // ne se traite pas comme un drawdown en VIX 14).
    let macro: object;
    try {
      macro = await this.lisa.getRecentMarketSnapshot(120);
    } catch (e) {
      this.logger.warn(`[shadow-sizing-gemini] macro fetch failed: ${String(e).slice(0, 100)}`);
      macro = { note: 'macro_snapshot_unavailable_this_cycle' };
    }

    // Macro news digest : 10 titres tier-1 sentiment fort, < 2h, dédupliqués.
    // But : enrichir le contexte de raisonnement sizing avec le régime narratif
    // sans noise (per-ticker news non pertinent à ce niveau méta).
    const newsDigest = await this.fetchMacroNewsDigest();

    const systemPrompt = SHADOW_SIZING_GEMINI_SYSTEM_PROMPT;
    const userPrompt = JSON.stringify({
      current_time_utc: new Date().toISOString(),
      target_usd_per_day: DAILY_TARGET_USD,
      drawdown_kill_threshold_pct: DRAWDOWN_KILL_PCT,
      macro,
      macro_news_digest: newsDigest,
      profiles: snapshots.map((s) => ({
        name: s.profileName,
        portfolio_id: s.portfolioId.slice(0, 8),
        open_positions: s.openPositions,
        closed_today: s.closedToday,
        realized_pnl_usd: s.realizedPnlUsd,
        unrealized_pnl_usd: s.unrealizedPnlUsd,
        fees_paid_usd: s.feesPaidUsd,
        net_pnl_after_fees_usd: s.netPnlAfterFeesUsd,
        target_progress_pct: s.targetProgressPct,
        drawdown_today_pct: s.drawdownTodayPct,
        win_rate_pct: s.winRatePct,
        capacity_used_pct: s.capacityUsedPct,
        kill_switch_active: s.killSwitchActive,
      })),
      history_last_6h: history,
      recent_decisions_per_profile: recentDecisions,
    }, null, 2);

    // Gemini Pro pour le raisonnement sizing — qualité supérieure sur l'analyse
    // comparative multi-profiles + macro. Auto-fallback Flash Lite si Pro down.
    let response: { content: string; providerId: string; costUsd: number; latencyMs: number };
    try {
      // maxTokens=3500 : Gemini Pro thinking budget (cf. fix 06:55 — 800 trop bas, content vide).
      response = await this.llmRouter.callWithPro({
        system: systemPrompt,
        user: userPrompt,
        temperature: 0.2,
        maxTokens: 3500,
        timeoutMs: 30_000,
      });
    } catch (e) {
      const errMsg = `LLM call failed: ${String(e).slice(0, 200)}`;
      this.logger.warn(`[shadow-sizing-gemini] ${errMsg}`);
      // Persist le fail en DB pour visibilité sans accès Fly logs.
      await this.logAutoTune({
        portfolioId: snapshots[0].portfolioId,
        profileName: 'gemini_fail',
        decisionKind: 'no_action',
        triggerMetric: 'gemini_llm_error',
        triggerValue: 0,
        thresholdValue: 0,
        actionApplied: false,
        rationale: `🤖 Gemini call FAILED — ${errMsg}`,
        payload: { error: errMsg },
      }).catch(() => null);
      return;
    }

    this.logger.log(
      `[shadow-sizing-gemini] provider=${response.providerId} latency=${response.latencyMs}ms cost=$${response.costUsd.toFixed(6)}`,
    );

    let decision: GeminiDecision;
    try {
      const cleaned = response.content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      decision = JSON.parse(cleaned);
    } catch (e) {
      this.logger.warn(`[shadow-sizing-gemini] parse JSON failed: ${String(e).slice(0, 150)} — raw: ${response.content.slice(0, 200)}`);
      return;
    }

    // Validation + safety bounds
    const MIN_CONFIDENCE = 0.7;
    const MAX_SIZING_DELTA_PCT = 20;  // changement sizing max 20%/cycle

    if (decision.action_kind === 'no_action') {
      await this.logAutoTune({
        portfolioId: snapshots[0].portfolioId,  // proxy
        profileName: 'gemini',
        decisionKind: 'sizing_suggestion',
        triggerMetric: 'gemini_no_action',
        triggerValue: decision.confidence ?? 0,
        thresholdValue: MIN_CONFIDENCE,
        actionApplied: false,
        rationale: `🤖 Gemini: NO_ACTION — ${decision.rationale ?? '(no rationale)'}`,
        payload: { decision, llm_meta: { providerId: response.providerId, latencyMs: response.latencyMs, costUsd: response.costUsd } },
      });
      return;
    }

    if (!decision.confidence || decision.confidence < MIN_CONFIDENCE) {
      await this.logAutoTune({
        portfolioId: snapshots[0].portfolioId,
        profileName: decision.target_profile ?? 'unknown',
        decisionKind: 'sizing_suggestion',
        triggerMetric: 'gemini_low_confidence',
        triggerValue: decision.confidence ?? 0,
        thresholdValue: MIN_CONFIDENCE,
        actionApplied: false,
        rationale: `🤖 Gemini suggéré ${decision.action_kind} sur ${decision.target_profile} mais confidence ${(decision.confidence ?? 0).toFixed(2)} < ${MIN_CONFIDENCE} — NON appliqué. Rationale: ${decision.rationale ?? '?'}`,
        payload: { decision },
      });
      return;
    }

    const target = snapshots.find((s) => s.profileName === decision.target_profile);
    if (!target) {
      this.logger.warn(`[shadow-sizing-gemini] target_profile '${decision.target_profile}' not found in snapshots`);
      return;
    }

    // Apply the decision
    let applied = false;
    let applyError: string | undefined;
    try {
      switch (decision.action_kind) {
        case 'kill':
          if (!target.killSwitchActive) {
            const { error } = await this.supabase.getClient()
              .from('lisa_session_configs')
              .update({ kill_switch_active: true, autopilot_paused_reason: 'SHADOW_GEMINI_KILL' })
              .eq('portfolio_id', target.portfolioId);
            applied = !error;
            applyError = error?.message;
          }
          break;
        case 'restart':
          if (target.killSwitchActive) {
            const { error } = await this.supabase.getClient()
              .from('lisa_session_configs')
              .update({ kill_switch_active: false, autopilot_paused_reason: null })
              .eq('portfolio_id', target.portfolioId);
            applied = !error;
            applyError = error?.message;
          }
          break;
        case 'raise_sizing':
        case 'lower_sizing': {
          const { data: cfg } = await this.supabase.getClient()
            .from('lisa_session_configs')
            .select('gainers_position_pct, gainers_max_open_positions')
            .eq('portfolio_id', target.portfolioId)
            .maybeSingle();
          const direction = decision.action_kind === 'raise_sizing' ? 1 : -1;
          let newPct = Number(cfg?.gainers_position_pct ?? 5);
          let newMax = Number(cfg?.gainers_max_open_positions ?? 10);
          if (decision.params?.new_position_pct != null) {
            const delta = decision.params.new_position_pct - newPct;
            const cappedDelta = Math.sign(delta) * Math.min(Math.abs(delta), newPct * MAX_SIZING_DELTA_PCT / 100);
            newPct = Math.max(1, Math.min(100, newPct + cappedDelta));
          } else {
            newPct = Math.max(1, Math.min(100, newPct * (1 + direction * 0.1)));
          }
          if (decision.params?.new_max_open != null) {
            newMax = Math.max(1, Math.min(50, decision.params.new_max_open));
          }
          const { error } = await this.supabase.getClient()
            .from('lisa_session_configs')
            .update({
              gainers_position_pct: Number(newPct.toFixed(2)),
              gainers_max_open_positions: newMax,
            })
            .eq('portfolio_id', target.portfolioId);
          applied = !error;
          applyError = error?.message;
          break;
        }
        case 'tune_tp_sl': {
          const tp = decision.params?.new_tp_pct;
          const sl = decision.params?.new_sl_pct;
          const update: { gainers_default_tp_pct?: number; gainers_default_sl_pct?: number } = {};
          if (tp != null) update.gainers_default_tp_pct = Math.max(0.1, Math.min(10, tp));
          if (sl != null) update.gainers_default_sl_pct = Math.max(0.1, Math.min(10, sl));
          if (Object.keys(update).length === 0) {
            applyError = 'tune_tp_sl mais aucun params new_tp_pct/new_sl_pct';
            break;
          }
          const { error } = await this.supabase.getClient()
            .from('lisa_session_configs')
            .update(update)
            .eq('portfolio_id', target.portfolioId);
          applied = !error;
          applyError = error?.message;
          break;
        }
        default:
          applyError = `unknown action_kind: ${decision.action_kind}`;
      }
    } catch (e) {
      applyError = String(e).slice(0, 200);
    }

    await this.logAutoTune({
      portfolioId: target.portfolioId,
      profileName: target.profileName,
      decisionKind: 'sizing_suggestion',
      triggerMetric: `gemini_${decision.action_kind}`,
      triggerValue: decision.confidence ?? 0,
      thresholdValue: MIN_CONFIDENCE,
      actionApplied: applied,
      rationale: applied
        ? `🤖 Gemini ${decision.action_kind.toUpperCase()} ${target.profileName} APPLIED (conf=${decision.confidence?.toFixed(2)}). ${decision.rationale ?? ''}`
        : `🤖 Gemini ${decision.action_kind} ${target.profileName} FAILED: ${applyError ?? 'unknown'}. ${decision.rationale ?? ''}`,
      payload: {
        decision,
        applied,
        applyError,
        llm_meta: { providerId: response.providerId, latencyMs: response.latencyMs, costUsd: response.costUsd },
      },
    });

    this.logger.log(
      `[shadow-sizing-gemini] ${applied ? '✅' : '❌'} ${decision.action_kind} ${decision.target_profile} (conf=${decision.confidence?.toFixed(2)}) — ${decision.rationale?.slice(0, 100) ?? ''}`,
    );
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
