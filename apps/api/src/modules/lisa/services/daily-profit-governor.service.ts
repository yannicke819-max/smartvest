import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { DecisionLogService } from './decision-log.service';
import { DailySessionService } from './daily-session.service';
import { ProfitSweepService } from './profit-sweep.service';
import type {
  DailyHarvestConfig,
  DailyTradingSession,
  HarvestState,
  CapitalDisciplineMode,
} from '../types/capital-discipline.types';
import { HARVEST_CONSTANTS } from '../types/capital-discipline.types';

/**
 * DailyProfitGovernor — orchestrateur du mode DAILY_HARVEST.
 *
 * RESPONSABILITÉS :
 *  1. Gérer la state machine des sessions (9 états documentés dans
 *     capital-discipline.types.ts)
 *  2. Évaluer si l'objectif/limite est atteint à chaque close de position
 *  3. Déclencher les sweeps (PER_TRADE ou END_OF_DAY) via ProfitSweepService
 *  4. Bloquer les ouvertures quand state ∈ {DAILY_LOCKED, LOSS_LIMIT_HIT, SESSION_CLOSED}
 *  5. Reset journalier en début de session (00:00 user timezone)
 *
 * INTÉGRATION :
 *  - Hook `onTradeClosed()` appelé par mechanical-trading.service.ts après
 *    chaque close de position
 *  - `canOpenPosition()` consulté par mechanical avant chaque ouverture
 *  - `runDailyTick()` appelé par lisa-autopilot.service.ts cron 60s
 *  - Inerte si capital_discipline_mode !== 'DAILY_HARVEST'
 *
 * COMPATIBILITÉ :
 *  - DelegationMode MANUAL/HYBRID/AUTONOMOUS : tous supportés
 *  - OperatingTempo LONG_HORIZON/ACTIVE/HYPER_ACTIVE : tous supportés
 *  - Sniper mode actif : compatible (sniper accélère les entries, harvest gère les exits)
 *  - Kill-switch global : prime sur le state machine harvest (kill-switch ferme tout)
 */
@Injectable()
export class DailyProfitGovernor {
  private readonly logger = new Logger(DailyProfitGovernor.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly decisionLog: DecisionLogService,
    private readonly dailySession: DailySessionService,
    private readonly profitSweep: ProfitSweepService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════
  // ENTRY POINT — appelé par mechanical-trading après chaque closePosition
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Hook après fermeture d'une position. Update les métriques de session,
   * déclenche le sweep si applicable, et fait avancer la state machine.
   *
   * Appelé fire-and-forget côté caller (ne JAMAIS bloquer le close).
   *
   * @param portfolioId
   * @param positionId
   * @param symbol
   * @param realizedPnlUsd Profit net (peut être négatif)
   * @param closeReason Reason from paper-broker (closed_target, closed_stop, etc.)
   */
  async onTradeClosed(
    portfolioId: string,
    positionId: string,
    symbol: string,
    realizedPnlUsd: number,
    closeReason: string,
  ): Promise<void> {
    try {
      // 1. Vérifie si le portfolio est en mode DAILY_HARVEST
      const { config, mode } = await this.loadConfig(portfolioId);
      if (mode !== 'DAILY_HARVEST' || !config) return;

      // 2. Récupère ou crée la session du jour
      const session = await this.dailySession.createOrGetTodaySession(portfolioId, config);

      // 3. Update métriques (realized + trades count + win/loss count)
      const newRealized = parseFloat(session.realizedPnlTodayUsd) + realizedPnlUsd;
      const isWin = realizedPnlUsd > 0;
      await this.dailySession.updateSessionMetrics(session.id, {
        realizedPnlTodayUsd: newRealized,
        tradesCount: session.tradesCount + 1,
        winningTradesCount: session.winningTradesCount + (isWin ? 1 : 0),
        losingTradesCount: session.losingTradesCount + (isWin ? 0 : 1),
      });

      // 4. Sweep PER_TRADE si applicable (uniquement si gain)
      if (config.profitSweepMode === 'PER_TRADE' && realizedPnlUsd > 0) {
        await this.profitSweep.sweepTradeProfit(session, positionId, symbol, realizedPnlUsd);
      }

      // 5. Re-charge la session avec les métriques fraîches (pour state machine)
      const refreshed = await this.dailySession.getCurrentSession(portfolioId, config.timezone);
      if (!refreshed) return;

      // 6. Évalue les transitions de state
      await this.evaluateStateTransition(refreshed, config, closeReason);

    } catch (e) {
      // Fire-and-forget côté caller — JAMAIS bloquer le close
      this.logger.warn(`onTradeClosed failed for ${positionId.slice(0, 8)}: ${String(e).slice(0, 200)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // STATE MACHINE — transitions selon métriques courantes
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Évalue l'état actuel et déclenche les transitions appropriées.
   * Idempotent : appelable plusieurs fois sans effet de bord.
   */
  private async evaluateStateTransition(
    session: DailyTradingSession,
    config: DailyHarvestConfig,
    triggerReason: string,
  ): Promise<void> {
    const progress = this.dailySession.computeProgress(session, config);
    const currentState = session.state;

    // États terminaux : aucune transition possible (sauf reset journalier)
    if (currentState === 'SESSION_CLOSED' || currentState === 'DAILY_LOCKED' || currentState === 'LOSS_LIMIT_HIT') {
      return;
    }

    // ── 1. LOSS_LIMIT_HIT (priorité haute — protection capital) ────
    if (config.maxLossPerDayUsd != null && progress.realizedToday <= -config.maxLossPerDayUsd) {
      await this.transitionTo(session, 'LOSS_LIMIT_HIT',
        `Perte journalière $${Math.abs(progress.realizedToday).toFixed(2)} ≥ max $${config.maxLossPerDayUsd}. Protection capital.`,
      );
      // Auto-cascade vers DAILY_LOCKED
      await this.transitionTo(session, 'DAILY_LOCKED',
        `Auto-lock suite à LOSS_LIMIT_HIT (interdit nouvelles entrées jusqu'au reset)`,
      );
      return;
    }

    // ── 2. Trades count cap (DAILY_LOCKED) ─────────────────────────
    if (config.maxTradesPerDay != null && session.tradesCount >= config.maxTradesPerDay) {
      await this.transitionTo(session, 'DAILY_LOCKED',
        `Cap maxTradesPerDay atteint (${session.tradesCount}/${config.maxTradesPerDay})`,
      );
      return;
    }

    // ── 3. TARGET_HIT (objectif atteint) ───────────────────────────
    if (progress.targetAmountUsd > 0 && progress.realizedToday >= progress.targetAmountUsd) {
      // Si déjà passé par TARGET_HIT, ne pas re-transitioner
      if (currentState !== 'TARGET_HIT' && currentState !== 'PROFIT_SWEEP_PENDING' && currentState !== 'PROFIT_SWEPT') {
        await this.transitionTo(session, 'TARGET_HIT',
          `Objectif atteint: realized $${progress.realizedToday.toFixed(2)} ≥ target $${progress.targetAmountUsd.toFixed(2)}`,
        );

        await this.decisionLog.append({
          portfolioId: session.portfolioId,
          kind: 'daily_harvest_target_hit',
          summary: `🎯 Target jour atteint: $${progress.realizedToday.toFixed(2)} (cible: $${progress.targetAmountUsd.toFixed(2)})`,
          rationale: `Objectif journalier touché. Trade trigger: ${triggerReason}. Trades aujourd'hui: ${session.tradesCount} (${session.winningTradesCount}W/${session.losingTradesCount}L). Mode sweep: ${config.profitSweepMode}.`,
          payload: {
            sessionId: session.id,
            realized: progress.realizedToday.toFixed(2),
            target: progress.targetAmountUsd.toFixed(2),
            tradesCount: session.tradesCount,
          },
          triggeredBy: 'autopilot_cron',
        }).catch(() => null);
      }

      // Si stopTradingWhenTargetHit, lock immédiat (transitionTo gère idempotence)
      if (config.stopTradingWhenTargetHit) {
        await this.transitionTo(session, 'DAILY_LOCKED',
          `stopTradingWhenTargetHit=true → blocage nouvelles entrées jusqu'au reset`,
        );

        await this.decisionLog.append({
          portfolioId: session.portfolioId,
          kind: 'daily_harvest_block_new_entries',
          summary: 'Blocage entrées suite à TARGET_HIT (stopTradingWhenTargetHit=true)',
          rationale: 'Objectif jour atteint et configuration demande arrêt total. Reset automatique au prochain sessionStartTime.',
          payload: { sessionId: session.id, state: 'DAILY_LOCKED' },
          triggeredBy: 'autopilot_cron',
        }).catch(() => null);
      }

      return;
    }

    // ── 4. TARGET_NEAR (≥80% de l'objectif) ────────────────────────
    if (
      progress.targetAmountUsd > 0 &&
      progress.progressPct >= HARVEST_CONSTANTS.TARGET_NEAR_THRESHOLD_PCT &&
      currentState === 'ACTIVE'
    ) {
      await this.transitionTo(session, 'TARGET_NEAR',
        `Approche objectif: ${progress.progressPct.toFixed(0)}% du target (realized $${progress.realizedToday.toFixed(2)}/$${progress.targetAmountUsd.toFixed(2)})`,
      );
      return;
    }

    // ── 5. ACTIVE (1ère ouverture après IDLE) ──────────────────────
    if (currentState === 'IDLE' && session.tradesCount > 0) {
      await this.transitionTo(session, 'ACTIVE',
        `1ère activité de la session journalière (${session.tradesCount} trades)`,
      );
      return;
    }
  }

  /**
   * Transition d'état avec audit + decision_log.
   */
  private async transitionTo(
    session: DailyTradingSession,
    newState: HarvestState,
    reason: string,
  ): Promise<void> {
    if (session.state === newState) return; // déjà dans cet état

    await this.dailySession.updateSessionState(session.id, newState, reason);

    await this.decisionLog.append({
      portfolioId: session.portfolioId,
      kind: 'daily_harvest_state_transition',
      summary: `${session.state} → ${newState}`,
      rationale: reason,
      payload: {
        sessionId: session.id,
        sessionDate: session.sessionDate,
        fromState: session.state,
        toState: newState,
      },
      triggeredBy: 'autopilot_cron',
    }).catch(() => null);

    this.logger.log(
      `[DAILY_HARVEST] ${session.portfolioId.slice(0, 8)} ${session.state} → ${newState} (${reason.slice(0, 80)})`,
    );

    // Mute à jour locale pour les checks suivants dans la même invocation
    session.state = newState;
  }

  // ═══════════════════════════════════════════════════════════════════
  // GATEKEEPER — appelé par mechanical avant ouverture
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Détermine si une nouvelle ouverture est autorisée selon l'état de la
   * session DAILY_HARVEST.
   *
   * - Si mode != DAILY_HARVEST → toujours OK (transparent)
   * - Si state ∈ {IDLE, ACTIVE, TARGET_NEAR, PROFIT_SWEPT} → OK
   * - Si state ∈ {TARGET_HIT, DAILY_LOCKED, LOSS_LIMIT_HIT, SESSION_CLOSED} → BLOQUÉ
   * - PROFIT_SWEEP_PENDING : OK (le sweep est en cours mais pas finalisé,
   *   on ne bloque pas pour ne pas freezer si le sweep traîne)
   */
  async canOpenPosition(portfolioId: string): Promise<{ allowed: boolean; reason?: string; state?: HarvestState }> {
    try {
      const { config, mode } = await this.loadConfig(portfolioId);
      if (mode !== 'DAILY_HARVEST' || !config) {
        return { allowed: true }; // mode inactif, transparent
      }

      const session = await this.dailySession.getCurrentSession(portfolioId, config.timezone);
      if (!session) {
        return { allowed: true }; // pas de session aujourd'hui = peut ouvrir (créera la session)
      }

      const blockedStates: HarvestState[] = ['TARGET_HIT', 'DAILY_LOCKED', 'LOSS_LIMIT_HIT', 'SESSION_CLOSED'];
      if (blockedStates.includes(session.state)) {
        return {
          allowed: false,
          state: session.state,
          reason: `DAILY_HARVEST état ${session.state} — nouvelles entrées bloquées jusqu'au reset (${config.sessionStartTime} ${config.timezone})`,
        };
      }

      // Si re-entry pas autorisée après TARGET_HIT et qu'on a déjà passé par cet état
      // (state actuel = PROFIT_SWEPT), check le flag
      if (session.state === 'PROFIT_SWEPT' && !config.allowReentryAfterTargetHit) {
        return {
          allowed: false,
          state: session.state,
          reason: `DAILY_HARVEST PROFIT_SWEPT + allowReentryAfterTargetHit=false — pas de re-entry dans la session`,
        };
      }

      return { allowed: true, state: session.state };
    } catch (e) {
      this.logger.warn(`canOpenPosition check failed for ${portfolioId.slice(0, 8)}: ${String(e).slice(0, 100)}`);
      return { allowed: true }; // fail-open : si check plante, on n'empêche pas le trading existant
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // CRON — appelé toutes les minutes par lisa-autopilot
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Tick périodique — vérifie pour chaque portfolio en mode DAILY_HARVEST :
   *  - Faut-il fermer la session (sessionEndTime atteint) ?
   *  - Faut-il sweeper end-of-day ?
   *  - Faut-il faire le reset journalier (nouveau jour calendaire) ?
   *
   * Idempotent : ne déclenche les actions que si réellement nécessaire.
   */
  async runDailyTick(): Promise<void> {
    try {
      const { data: configs } = await this.supabase.getClient()
        .from('lisa_session_configs')
        .select('portfolio_id, capital_discipline_mode, daily_harvest_config')
        .eq('capital_discipline_mode', 'DAILY_HARVEST');

      if (!configs || configs.length === 0) return;

      for (const cfg of configs) {
        const portfolioId = cfg.portfolio_id as string;
        const config = cfg.daily_harvest_config as DailyHarvestConfig | null;
        if (!config) continue;

        try {
          await this.evaluateSessionLifecycle(portfolioId, config);
        } catch (e) {
          this.logger.warn(`runDailyTick failed for ${portfolioId.slice(0, 8)}: ${String(e).slice(0, 100)}`);
        }
      }
    } catch (e) {
      this.logger.error(`runDailyTick fatal: ${String(e).slice(0, 200)}`);
    }
  }

  /**
   * Vérifie le lifecycle d'une session :
   *  - Si session du jour absent + on est dans la fenêtre horaire → log info (créée à la 1ère ouverture)
   *  - Si session présente + sessionEndTime atteint → close + sweep END_OF_DAY si applicable
   */
  private async evaluateSessionLifecycle(portfolioId: string, config: DailyHarvestConfig): Promise<void> {
    const session = await this.dailySession.getCurrentSession(portfolioId, config.timezone);
    if (!session) return;
    if (session.state === 'SESSION_CLOSED') return; // déjà clôturée

    // Calcule l'heure courante en timezone user
    const nowInTz = this.getTimeInTimezone(config.timezone);
    const isAfterEnd = this.isTimeAfterOrEqual(nowInTz, config.sessionEndTime);

    if (isAfterEnd) {
      // Sweep END_OF_DAY si applicable
      if (config.profitSweepMode === 'END_OF_DAY') {
        await this.profitSweep.sweepEndOfDay(session);
      }

      // Ferme la session
      await this.dailySession.closeSession(session.id, `Session end time atteint (${config.sessionEndTime} ${config.timezone})`);

      await this.decisionLog.append({
        portfolioId,
        kind: 'daily_harvest_session_closed',
        summary: `Session ${session.sessionDate} fermée (fin journée ${config.sessionEndTime})`,
        rationale: `Realized: $${session.realizedPnlTodayUsd}. Secured: $${session.securedPnlTodayUsd}. Trades: ${session.tradesCount} (${session.winningTradesCount}W/${session.losingTradesCount}L).`,
        payload: {
          sessionId: session.id,
          finalRealized: session.realizedPnlTodayUsd,
          finalSecured: session.securedPnlTodayUsd,
          finalState: session.state,
          tradesCount: session.tradesCount,
        },
        triggeredBy: 'autopilot_cron',
      }).catch(() => null);

      this.logger.log(
        `[DAILY_HARVEST] Session closed portfolio=${portfolioId.slice(0, 8)} date=${session.sessionDate} realized=$${session.realizedPnlTodayUsd}`,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // HELPERS PRIVÉS
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Charge le mode + la config DAILY_HARVEST d'un portfolio.
   */
  private async loadConfig(portfolioId: string): Promise<{
    mode: CapitalDisciplineMode;
    config: DailyHarvestConfig | null;
  }> {
    const { data } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('capital_discipline_mode, daily_harvest_config')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    if (!data) return { mode: 'NONE', config: null };

    const mode = (data.capital_discipline_mode as CapitalDisciplineMode) ?? 'NONE';
    const config = (data.daily_harvest_config as DailyHarvestConfig | null) ?? null;
    return { mode, config };
  }

  /**
   * Retourne l'heure courante en timezone donnée, format "HH:MM".
   */
  private getTimeInTimezone(timezone: string): string {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return formatter.format(new Date());
  }

  /**
   * Compare 2 timestamps "HH:MM". Retourne true si time >= target.
   */
  private isTimeAfterOrEqual(time: string, target: string): boolean {
    const [tH, tM] = time.split(':').map(Number);
    const [targetH, targetM] = target.split(':').map(Number);
    const tMin = tH * 60 + tM;
    const targetMin = targetH * 60 + targetM;
    return tMin >= targetMin;
  }
}
