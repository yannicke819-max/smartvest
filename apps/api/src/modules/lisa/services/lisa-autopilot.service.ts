import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { SupabaseService } from '../../supabase/supabase.service';
import { PerformanceService } from '../../performance/performance.service';
import { LisaService } from './lisa.service';
import { DecisionLogService } from './decision-log.service';
import { RealtimePriceService } from './realtime-price.service';
import { MaterialChangeDetectorService } from './material-change-detector.service';
import { DailyProfitGovernor } from './daily-profit-governor.service';
import { LisaReplayConnectorService } from '../../bot-lab/services/lisa-replay-connector.service';

/** Tickers macro et indices stratégiques que Lisa consulte en permanence.
 *  Warmed une fois au boot pour peupler le cache immédiatement, évite le
 *  premier cycle où le cache est froid. */
const BOOT_WARMUP_TICKERS = [
  'VIX', 'DXY', 'BRENT', 'GOLD', 'SILVER',
  'SPY', 'QQQ', 'IWM', 'EEM', 'TLT', 'HYG',
  'EURUSD', 'USDJPY', 'GBPUSD',
];

/**
 * LisaAutopilotService — Cron scheduler for portfolios with autopilot enabled.
 *
 * Tourne toutes les 5 minutes (configurable). Pour chaque portfolio simu
 * avec autopilot_enabled = true :
 *  1. Vérifie kill_switch_active → skip si true
 *  2. Vérifie cycle_minutes écoulé depuis le dernier cycle
 *  3. Run risk check (snapshot + drawdown + stops/targets/horizons)
 *  4. Si OK → génère nouvelle proposition (si profile warrant it)
 *  5. Log decision entry `autopilot_cycle_completed`
 *
 * RESPECT HARD LIMITS :
 *  - Si drawdown 2j > -10% → kill switch auto + skip
 *  - Si drawdown 7j > limit → pause nouvelles positions (warning)
 */
@Injectable()
export class LisaAutopilotService implements OnApplicationBootstrap {
  /** UUID unique par process. Permet au mutex Postgres d'identifier
   *  quelle instance Fly tient le lock. Généré une fois au démarrage. */
  private readonly instanceId = randomUUID();

  /** Pre-warmer : au démarrage de l'app, alimente le cache avec les tickers
   *  macro essentiels. Coût : ~14 appels EODHD one-shot (0.014% du quota). */
  async onApplicationBootstrap(): Promise<void> {
    this.logger.log(`Instance ${this.instanceId.slice(0, 8)} — Pre-warming ${BOOT_WARMUP_TICKERS.length} macro tickers...`);
    try {
      await Promise.all(BOOT_WARMUP_TICKERS.map((t) =>
        this.lisa.warmPrice(t).catch(() => { /* ignore individual failures */ }),
      ));
      this.logger.log('Pre-warm completed');
    } catch (e) {
      this.logger.warn(`Pre-warm partial failure: ${String(e).slice(0, 120)}`);
    }
  }

  private readonly logger = new Logger(LisaAutopilotService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
    private readonly decisionLog: DecisionLogService,
    private readonly realtimePrice: RealtimePriceService,
    private readonly performance: PerformanceService,
    private readonly materialDetector: MaterialChangeDetectorService,
    private readonly dailyProfitGovernor: DailyProfitGovernor,
    private readonly lisaReplay: LisaReplayConnectorService,
  ) {}

  /**
   * Cron BOT LAB auto-sync — toutes les 30 minutes.
   * Pour chaque user actif (= ayant au moins 1 portfolio simulation),
   * sync les trades Lisa fermés vers les bots "Lisa Live" pour analyse
   * Bot Lab.
   *
   * Idempotent : ne duplique pas (UNIQUE constraint bot_id + external_id).
   * Inerte si aucun nouveau trade.
   */
  @Cron('0 */30 * * * *', { name: 'lisa-replay-sync' })
  async runLisaReplaySync() {
    const locked = await this.acquireCronLock('lisa_replay_sync', 600);
    if (!locked) return;
    try {
      // Récupère tous les user_id distincts ayant au moins un portfolio simulation
      const { data: users } = await this.supabase.getClient()
        .from('portfolios')
        .select('user_id')
        .eq('is_simulation', true);

      const userIds = Array.from(new Set((users ?? []).map((u) => u.user_id as string)));
      let totalImported = 0;
      let totalUsers = 0;

      for (const userId of userIds) {
        try {
          const result = await this.lisaReplay.syncAllForUser(userId);
          if (result.totalImported > 0) {
            totalImported += result.totalImported;
            totalUsers++;
          }
        } catch (e) {
          this.logger.warn(`lisa-replay-sync failed for user ${userId.slice(0, 8)}: ${String(e).slice(0, 100)}`);
        }
      }

      if (totalImported > 0) {
        this.logger.log(`[LISA_REPLAY_CRON] Synced ${totalImported} new trades across ${totalUsers} users`);
      }
    } finally {
      await this.releaseCronLock('lisa_replay_sync');
    }
  }

  /**
   * Cron DAILY_HARVEST — toutes les 60s.
   * Vérifie pour chaque portfolio en mode DAILY_HARVEST :
   *  - Faut-il fermer la session (sessionEndTime atteint) ?
   *  - Faut-il sweeper end-of-day ?
   *  - Faut-il faire le reset journalier ?
   *
   * Inerte si aucun portfolio n'est en mode DAILY_HARVEST.
   * Idempotent : ne déclenche les actions que si nécessaire.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'daily-harvest-governor' })
  async runDailyHarvestGovernor() {
    const locked = await this.acquireCronLock('daily_harvest_governor', 90);
    if (!locked) return;
    try {
      await this.dailyProfitGovernor.runDailyTick();
    } finally {
      await this.releaseCronLock('daily_harvest_governor');
    }
  }

  /**
   * Tente d'acquérir le mutex distribué (table lisa_cron_locks).
   * Retourne true si ce process tient le lock, false si une autre instance
   * le détient déjà. Le lock expire après 180s pour gérer les crashs.
   */
  private async acquireCronLock(lockName: string, timeoutSeconds = 180): Promise<boolean> {
    try {
      const { data, error } = await this.supabase.getClient()
        .rpc('acquire_cron_lock', {
          p_name: lockName,
          p_instance_id: this.instanceId,
          p_timeout_seconds: timeoutSeconds,
        });
      if (error) {
        // Si la migration 0049 n'est pas encore appliquée, on laisse passer
        // pour ne pas bloquer le service au démarrage.
        this.logger.debug(`acquire_cron_lock RPC unavailable (migration pending?): ${error.message}`);
        return true;
      }
      return data === true;
    } catch {
      return true; // fail-open plutôt que de bloquer tous les cycles
    }
  }

  private async releaseCronLock(lockName: string): Promise<void> {
    try {
      await this.supabase.getClient()
        .from('lisa_cron_locks')
        .delete()
        .eq('name', lockName)
        .eq('instance_id', this.instanceId);
    } catch { /* ignore release errors */ }
  }

  /** Tick toutes les 60 secondes. Chaque portfolio a son propre cycle_minutes
   *  (min 1 min) qui détermine s'il est dû — permet aux users en hyper-trading
   *  de tourner toutes les 1-2 min alors que les longs-termistes restent à 60. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'lisa-autopilot' })
  async runAutopilotCycle() {
    // Mutex distribué : une seule instance Fly exécute le cycle à la fois.
    // Les 15 autres éventuelles instances skippent proprement → 0 Claude / 0 EODHD.
    const locked = await this.acquireCronLock('autopilot_cycle');
    if (!locked) {
      this.logger.debug(`[${this.instanceId.slice(0, 8)}] autopilot_cycle skipped — autre instance active`);
      return;
    }

    try {
      await this.runAutopilotCycleInner();
    } finally {
      await this.releaseCronLock('autopilot_cycle');
    }
  }

  private async runAutopilotCycleInner() {
    // SELECT * plutôt que liste explicite : si la migration 0047 n'est pas
    // encore appliquée et que autopilot_market_hours_only n'existe pas en DB,
    // Supabase ne plante pas sur la colonne manquante — toutes les colonnes
    // présentes sont renvoyées, et autopilot_market_hours_only sera undefined
    // donc lu comme false (comportement "désactivé" côté logique).
    const { data: configs, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('*')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);

    if (error) {
      this.logger.error(`Autopilot cycle: failed to fetch configs: ${error.message}`);
      return;
    }

    if (!configs || configs.length === 0) return;

    this.logger.log(`Autopilot cycle: ${configs.length} portfolio(s) in autopilot mode`);

    // Fenêtre "heures de marché" : 07:00-20:00 UTC
    // (= 09:00-22:00 CET été / 08:00-21:00 CET hiver, couvre Euronext + NYSE)
    const currentHourUtc = new Date().getUTCHours();
    const inMarketHours = currentHourUtc >= 7 && currentHourUtc < 20;

    for (const cfg of configs) {
      try {
        // Skip si market_hours_only activé ET hors fenêtre.
        // Log discret pour que l'utilisateur puisse diagnostiquer l'inactivité.
        if (cfg.autopilot_market_hours_only === true && !inMarketHours) {
          this.logger.log(`Portfolio ${String(cfg.portfolio_id)}: market_hours_only=true, skip (UTC ${currentHourUtc}h, fenêtre 7-20 UTC)`);
          continue;
        }

        // Auto-expire le mode auto_approve si deadline dépassée
        const autoApprove = cfg.autopilot_auto_approve === true;
        const expiresAt = cfg.autopilot_expires_at as string | null;
        const expired = autoApprove && !!expiresAt && new Date(expiresAt).getTime() <= Date.now();
        if (expired) {
          this.logger.log(`Portfolio ${String(cfg.portfolio_id)}: auto_approve EXPIRÉ — désactivation`);
          await this.supabase.getClient()
            .from('lisa_session_configs')
            .update({ autopilot_auto_approve: false, autopilot_expires_at: null })
            .eq('portfolio_id', cfg.portfolio_id as string);
          await this.decisionLog.append({
            portfolioId: cfg.portfolio_id as string,
            kind: 'autopilot_auto_approve_expired',
            summary: 'Mode auto-approve expiré — désactivation automatique',
            rationale: `Deadline ${expiresAt} dépassée`,
            payload: {},
            triggeredBy: 'autopilot_cron',
          }).catch((e) => this.logger.warn(`log append failed: ${String(e)}`));
        }

        await this.runPortfolioCycle(
          cfg.user_id as string,
          cfg.portfolio_id as string,
          (cfg.autopilot_cycle_minutes as number) ?? 60,
          autoApprove && !expired,
          // PATCH 1 — kill-switch dataQuality. Si false (default), le cycle
          // sera skippé quand le snapshot macro est dégradé. Cf. PR#1 P0.
          cfg.allow_degraded_macro === true,
        );
      } catch (e) {
        this.logger.error(
          `Autopilot cycle failed for portfolio ${String(cfg.portfolio_id)}: ${String(e)}`,
        );
      }
    }
  }

  /**
   * Mutex in-memory par portfolioId pour empêcher 2 ticks cron concurrents
   * d'exécuter le même runPortfolioCycle en parallèle (race condition
   * observée : 3 propositions générées en 71 sec parce que 3 ticks lisaient
   * le même lastCycle stale).
   *
   * Garde-fou anti-hang (incident 26/04 7:45 → 8:28) : si un cycle pend
   * (await DB / fetch / Anthropic indéfiniment), le finally { delete }
   * n'est jamais atteint, le portfolioId reste dans le Set, tous les
   * ticks suivants skip silencieusement. cycleStartedAt enregistre le
   * timestamp pour permettre une force-release après MUTEX_MAX_AGE_MS.
   */
  private readonly runningCycles = new Set<string>();
  private readonly cycleStartedAt = new Map<string, number>();
  private static readonly MUTEX_MAX_AGE_MS = 5 * 60_000; // 5 min

  private async runPortfolioCycle(
    userId: string,
    portfolioId: string,
    cycleMinutes: number,
    autoApprove: boolean = false,
    allowDegradedMacro: boolean = false,
  ): Promise<void> {
    // Mutex in-memory : skip si un cycle est déjà en cours pour ce portfolio
    if (this.runningCycles.has(portfolioId)) {
      const startedAt = this.cycleStartedAt.get(portfolioId) ?? 0;
      const ageMs = Date.now() - startedAt;
      if (ageMs > LisaAutopilotService.MUTEX_MAX_AGE_MS) {
        // Cycle hangs depuis > 5 min → force release pour débloquer
        this.logger.warn(
          `[mutex] portfolio ${portfolioId.slice(0, 8)} stuck since ${Math.round(ageMs / 60_000)}min — force release`,
        );
        this.runningCycles.delete(portfolioId);
        this.cycleStartedAt.delete(portfolioId);
        // Ne pas return : on continue avec un mutex propre pour ce tick
      } else {
        return; // Mutex récent, skip normal
      }
    }
    this.runningCycles.add(portfolioId);
    this.cycleStartedAt.set(portfolioId, Date.now());
    try {
      await this.runPortfolioCycleInner(userId, portfolioId, cycleMinutes, autoApprove, allowDegradedMacro);
    } finally {
      this.runningCycles.delete(portfolioId);
      this.cycleStartedAt.delete(portfolioId);
    }
  }

  private async runPortfolioCycleInner(
    userId: string,
    portfolioId: string,
    cycleMinutes: number,
    autoApprove: boolean = false,
    allowDegradedMacro: boolean = false,
  ): Promise<void> {
    // 1. Rate limit baseline = MAX(dernier cycle_started OU completed,
    //    dernière proposal). Source de vérité = lisa_proposals.created_at
    //    car même si cycle_started/completed plantent, une proposal créée
    //    bloque les ticks suivants.
    const [lastCycleRes, lastProposalRes] = await Promise.all([
      this.supabase.getClient()
        .from('lisa_decision_log')
        .select('timestamp')
        .eq('portfolio_id', portfolioId)
        .in('kind', ['autopilot_cycle_started', 'autopilot_cycle_completed'])
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle(),
      this.supabase.getClient()
        .from('lisa_proposals')
        .select('created_at')
        .eq('portfolio_id', portfolioId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const lastCycleTs = (lastCycleRes.data?.timestamp as string | undefined) ?? null;
    const lastProposalTs = (lastProposalRes.data?.created_at as string | undefined) ?? null;
    const lastBaselineTs = [lastCycleTs, lastProposalTs]
      .filter((t): t is string => Boolean(t))
      .map((t) => new Date(t).getTime())
      .reduce((max, t) => Math.max(max, t), 0);

    // EVENT-DRIVEN MODE
    // Au lieu d'attendre l'intervalle cycle_minutes (20 min default), on
    // déclenche dès qu'un événement matériel est détecté, avec :
    //  - Rate limit min 3 min entre 2 cycles (anti-spam si VIX vacille)
    //  - Filet de garantie configurable (5-60 min) — force un cycle même si
    //    calme. Lit autopilot_cycle_minutes de la config (UI), clamp [5, 60].
    //    Permet à l'utilisateur de moduler la cadence d'observation selon
    //    son appétit (5 min = très réactif, 60 min = passif). Default 30 min.
    const RATE_LIMIT_MIN = 3;
    const configuredCycleMin = Number(cycleMinutes) || 30;
    const SAFETY_NET_MIN = Math.max(5, Math.min(60, configuredCycleMin));
    let triggerReason = `bootstrap (premier cycle)`;
    let triggerKind: 'event' | 'safety_net' | 'bootstrap' = 'bootstrap';

    if (lastBaselineTs > 0) {
      const elapsedMs = Date.now() - lastBaselineTs;
      const elapsedMin = elapsedMs / 60_000;

      // Rate limit dur : jamais 2 cycles à moins de 3 min
      if (elapsedMin < RATE_LIMIT_MIN) {
        return;
      }

      // Charge les positions tenues pour le détecteur
      const { data: openPositions } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('symbol')
        .eq('portfolio_id', portfolioId)
        .eq('status', 'open');
      const heldSymbols = Array.from(new Set((openPositions ?? []).map((p) => String(p.symbol))));

      // Détection event-driven
      const detection = await this.materialDetector.detect(portfolioId, heldSymbols)
        .catch((e) => {
          this.logger.warn(`MaterialDetector failed: ${String(e).slice(0, 120)} — fallback time-based`);
          return null;
        });

      if (detection?.triggered) {
        triggerKind = 'event';
        triggerReason = detection.reasons.slice(0, 3).join(' · ');
      } else if (elapsedMin >= SAFETY_NET_MIN) {
        triggerKind = 'safety_net';
        triggerReason = `filet de garantie ${SAFETY_NET_MIN}min sans event`;
      } else {
        // Pas d'event ET pas encore au filet → skip
        return;
      }

      // Persiste la raison du trigger pour visibilité UI
      await this.supabase.getClient()
        .from('lisa_session_configs')
        .update({
          last_event_trigger_reason: `[${triggerKind}] ${triggerReason}`.slice(0, 200),
          last_event_trigger_at: new Date().toISOString(),
        })
        .eq('portfolio_id', portfolioId)
        .then(({ error }) => {
          if (error) this.logger.debug(`trigger reason update failed: ${error.message}`);
        });
    }

    // 2. Log cycle start avec la raison
    await this.decisionLog.append({
      portfolioId,
      kind: 'autopilot_cycle_started',
      summary: `Autopilot cycle started [${triggerKind}]`,
      rationale: triggerReason,
      payload: { triggerKind, triggerReason },
      triggeredBy: 'autopilot_cron',
    }).catch((e) => this.logger.warn(`log append failed: ${String(e)}`));

    // 3. Run risk check (hard kill if drawdown breached, close stops/targets)
    const riskResult = await this.lisa.runRiskCheck(userId, portfolioId).catch((e) => {
      this.logger.error(`Risk check failed: ${String(e)}`);
      return null;
    });

    if (!riskResult) return;

    // 4. If HARD KILL triggered, stop — already handled by risk monitor
    if (riskResult.status === 'hard_kill') {
      this.logger.warn(`Portfolio ${portfolioId}: HARD KILL triggered — skipping proposal generation`);
      return;
    }

    // 5. If critical drawdown, pause new proposals (user review forced)
    if (riskResult.status === 'critical') {
      this.logger.warn(`Portfolio ${portfolioId}: critical drawdown — pausing new proposals`);
      await this.decisionLog.append({
        portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: 'Cycle completed (new proposals paused — critical drawdown)',
        rationale: riskResult.violations.map((v) => v.message).join(' | '),
        payload: { riskStatus: riskResult.status },
        triggeredBy: 'autopilot_cron',
      }).catch((e) => this.logger.warn(`log append failed: ${String(e)}`));
      return;
    }

    // PATCH 1 — Kill-switch dataQuality (PR#1 P0).
    // Si le snapshot macro est dégradé (us10y+vix en fallback OU 3+ feeds
    // en fallback), on skip le cycle pour ne pas gaspiller un appel Claude
    // (~$0.17 Opus) sur des inputs non fiables. L'utilisateur peut bypass
    // via config.allow_degraded_macro = true.
    const guardSnapshot = await this.lisa.fetchMarketSnapshot().catch((e) => {
      this.logger.warn(`[dataQuality guard] fetchMarketSnapshot failed: ${String(e).slice(0, 120)}`);
      return null;
    });
    if (guardSnapshot?.dataQuality?.degraded === true && !allowDegradedMacro) {
      const fallbackList = guardSnapshot.dataQuality.fallback ?? [];
      this.logger.warn(
        `[dataQuality guard] cycle skipped — fallback feeds: ${fallbackList.join(', ')}`,
      );
      await this.decisionLog.append({
        portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: `Cycle skipped (data quality degraded — ${fallbackList.length} feeds en fallback)`,
        rationale: `Macro snapshot non fiable : ${fallbackList.join(', ')}. Cycle Lisa épargné pour éviter un raisonnement sur inputs hardcoded. Active config.allow_degraded_macro pour outrepasser.`,
        payload: {
          reason: 'data_quality_degraded',
          fallbackFeeds: fallbackList,
          live: guardSnapshot.dataQuality.live,
          proxy: guardSnapshot.dataQuality.proxy,
        },
        triggeredBy: 'autopilot_cron',
      }).catch((e) => this.logger.warn(`log append failed: ${String(e)}`));
      return;
    }

    // 6. OK path : generate new proposal + optionally auto-approve (simulation only)
    try {
      const proposal = await this.lisa.generateProposal(
        userId,
        portfolioId,
        autoApprove
          ? 'Autopilot agressif (simulation) — scan EV+ multi-asset, turnover élevé, coupure sèche des positions défavorables'
          : 'Autopilot cycle — scan pour opportunities intraday multi-asset',
      );

      let autoApproveResult: { openedPositions: number } | null = null;
      if (autoApprove && proposal.theses.length > 0) {
        // Safety net : un dernier check que le portfolio est bien is_simulation
        // (le LisaService a déjà vérifié mais on ne laisse rien passer).
        const { data: portfolio } = await this.supabase.getClient()
          .from('portfolios')
          .select('is_simulation')
          .eq('id', portfolioId)
          .maybeSingle();

        if (portfolio?.is_simulation !== true) {
          this.logger.error(`Portfolio ${portfolioId} n'est PAS is_simulation — auto_approve REFUSÉ`);
        } else {
          try {
            const result = await this.lisa.approveProposal(userId, proposal.id);
            autoApproveResult = { openedPositions: result.openedPositions.length };
            this.logger.log(`Autopilot auto-approved proposal ${proposal.id}: ${result.openedPositions.length} position(s) opened`);
          } catch (e) {
            this.logger.error(`Auto-approve failed for ${proposal.id}: ${String(e)}`);
          }
        }
      }

      const momentumTag = proposal.marketMomentum === 'bullish_strong'
        ? ' · ▲ bullish_strong'
        : proposal.marketMomentum === 'bearish' ? ' · ▼ bearish' : '';

      await this.decisionLog.append({
        portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: autoApproveResult
          ? `Cycle completed: ${proposal.theses.length} theses, ${autoApproveResult.openedPositions} positions auto-ouvertes${momentumTag}`
          : `Cycle completed: proposal generated (${proposal.theses.length} theses)${momentumTag}`,
        rationale: proposal.regimeSummary,
        payload: {
          proposalId: proposal.id,
          regime: proposal.detectedRegime,
          marketMomentum: proposal.marketMomentum,
          thesesCount: proposal.theses.length,
          riskStatus: riskResult.status,
          autoApproved: autoApproveResult !== null,
          openedPositions: autoApproveResult?.openedPositions ?? 0,
        },
        triggeredBy: 'autopilot_cron',
      }).catch((e) => this.logger.warn(`log append failed: ${String(e)}`));
    } catch (e) {
      this.logger.error(`Proposal generation in autopilot failed: ${String(e)}`);
      await this.decisionLog.append({
        portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: 'Cycle completed with error',
        rationale: String(e).slice(0, 2000),
        payload: {},
        triggeredBy: 'autopilot_cron',
      }).catch((err) => this.logger.warn(`log append failed: ${String(err)}`));
    }

    // Snapshot daily performance (upsert — 1 row/day, mise à jour en continu)
    await this.performance.takeSnapshot(portfolioId)
      .catch((e) => this.logger.warn(`performance snapshot failed: ${String(e)}`));
  }

  /**
   * Risk monitor rapide : tourne toutes les 60 secondes, INDÉPENDAMMENT du
   * cycle Claude (qui peut être à 5 ou 15 min). Vérifie stops / targets /
   * horizons sur toutes les positions ouvertes des portefeuilles en autopilot.
   *
   * Permet de fermer une perdante en moins d'1 min même si le prochain cycle
   * Claude n'est que dans 14 min. Critique pour la réactivité en mode sniper.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'lisa-fast-risk-monitor' })
  async runFastRiskMonitor() {
    const locked = await this.acquireCronLock('fast_risk_monitor', 90);
    if (!locked) return;
    try {
      await this.runFastRiskMonitorInner();
    } finally {
      await this.releaseCronLock('fast_risk_monitor');
    }
  }

  /**
   * Cron snapshot portfolio toutes les 5 min, indépendamment de l'activité
   * Lisa. Avant ce cron, les snapshots étaient créés UNIQUEMENT sur events
   * (ouverture/fermeture position, fin de cycle Lisa). Avec Phase 4
   * event-driven, si rien ne se passe pendant 30+ min, le graphique
   * /lisa stagnait alors que la valeur live (calculée à chaque chargement)
   * affichait des chiffres différents.
   *
   * Effet : graphique toujours à jour à <5 min de la valeur live.
   * Coût : ~12 inserts/heure/portfolio (négligeable).
   */
  @Cron('0 */5 * * * *', { name: 'lisa-portfolio-snapshot', timeZone: 'UTC' })
  async runPortfolioSnapshotter() {
    const locked = await this.acquireCronLock('portfolio_snapshotter', 280);
    if (!locked) return;
    try {
      await this.runPortfolioSnapshotterInner();
    } finally {
      await this.releaseCronLock('portfolio_snapshotter');
    }
  }

  private async runPortfolioSnapshotterInner() {
    const { data: configs } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('portfolio_id')
      .eq('autopilot_enabled', true);

    if (!configs || configs.length === 0) return;

    for (const cfg of configs) {
      const portfolioId = cfg.portfolio_id as string;
      try {
        // Persiste un snapshot live via Lisa (calcul cohérent avec UI top)
        await this.lisa.persistLivePortfolioSnapshot(portfolioId);
      } catch (e) {
        this.logger.debug(`snapshot failed for ${portfolioId}: ${String(e).slice(0, 80)}`);
      }
    }
  }

  private async runFastRiskMonitorInner() {
    const { data: configs, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('user_id, portfolio_id')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);

    if (error || !configs || configs.length === 0) return;

    for (const cfg of configs) {
      try {
        await this.lisa.runRiskCheck(cfg.user_id as string, cfg.portfolio_id as string);
      } catch (e) {
        this.logger.debug(`fast risk monitor skipped for ${String(cfg.portfolio_id)}: ${String(e).slice(0, 80)}`);
      }
    }
  }

  /**
   * Price warmer : toutes les 30 s, rafraîchit les prix de TOUS les symboles
   * des positions ouvertes.
   *
   * - Crypto : inscrit le symbole dans RealtimePriceService → reçoit les
   *   ticks WebSocket Binance en continu (~1 tick/seconde, gratuit).
   * - Non-crypto : pull EODHD et push dans le cache. Volume estimé :
   *   ~10 positions × 2 req/min = 20/min = 28.800/jour, soit 29% du quota
   *   100k/j. Marge confortable.
   *
   * Effet : fetchLivePrice (qui lit le cache en priorité) coûte 0 appel
   * EODHD dans 95% des cas, et les risk checks voient des prix frais (<30s).
   */
  @Cron('*/30 * * * * *', { name: 'lisa-price-warmer' })
  async runPriceWarmer() {
    const locked = await this.acquireCronLock('price_warmer', 45);
    if (!locked) return;
    try {
      await this.runPriceWarmerInner();
    } finally {
      await this.releaseCronLock('price_warmer');
    }
  }

  private async runPriceWarmerInner() {
    // 1. Récupère toutes les positions ouvertes des portfolios en autopilot
    const { data: configs } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('portfolio_id')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);

    if (!configs || configs.length === 0) {
      this.realtimePrice.updateActiveCryptoSymbols([]);
      return;
    }

    const portfolioIds = configs.map((c) => c.portfolio_id as string);

    const { data: positions } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('symbol, asset_class')
      .in('portfolio_id', portfolioIds)
      .eq('status', 'open');

    if (!positions || positions.length === 0) {
      this.realtimePrice.updateActiveCryptoSymbols([]);
      return;
    }

    // 2. Sépare crypto (WS) vs autres (EODHD pull)
    const cryptoSymbols = new Set<string>();
    const otherSymbols = new Set<string>();
    for (const pos of positions) {
      const assetClass = String(pos.asset_class ?? '');
      const symbol = String(pos.symbol ?? '');
      if (!symbol) continue;
      if (assetClass.startsWith('crypto_')) cryptoSymbols.add(symbol);
      else otherSymbols.add(symbol);
    }

    // 3. Met à jour la liste Binance WS (auto-reconnecte si changement)
    this.realtimePrice.updateActiveCryptoSymbols(Array.from(cryptoSymbols));

    // 4. Pull EODHD en parallèle pour les non-crypto (cache-miss only — on ne
    //    refetch pas si un ticker a déjà un prix de <30s).
    // Serrer à 15s (avec cron à 30s → refresh chaque tick = max age 30s)
    const STALE_MS = 15_000;
    const toRefresh = Array.from(otherSymbols).filter((s) => {
      const cached = this.realtimePrice.getCached(s);
      if (!cached) return true;
      return (Date.now() - new Date(cached.asOf).getTime()) > STALE_MS;
    });

    if (toRefresh.length > 0) {
      // Appelle lisa.fetchLivePrice — qui gère EODHD + fallback + logEodhdCall
      // + push vers le cache automatiquement.
      await Promise.all(toRefresh.map((s) =>
        this.lisa.warmPrice(s).catch(() => { /* ignore individual failures */ }),
      ));
      this.logger.debug(`Price warmer: refreshed ${toRefresh.length} non-crypto symbols, ${cryptoSymbols.size} crypto on WS`);
    }
  }
}
