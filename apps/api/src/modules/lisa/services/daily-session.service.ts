import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import type {
  DailyTradingSession,
  HarvestState,
  DailyHarvestConfig,
  SecuredProfitBalance,
  DailyHarvestProgress,
} from '../types/capital-discipline.types';
import { HARVEST_CONSTANTS } from '../types/capital-discipline.types';

/**
 * DailySessionService — accès CRUD aux sessions de trading journalières et
 * au vault des profits sécurisés.
 *
 * IMPORTANT : ce service ne contient PAS de logique métier (state machine,
 * détection target, sweep). Il est uniquement responsable de l'I/O DB.
 *
 * La logique métier vit dans :
 *  - DailyProfitGovernor (Phase 2) : orchestrator + state machine
 *  - ProfitSweepService (Phase 2) : logique sweep PER_TRADE/END_OF_DAY
 *
 * Cette séparation permet de tester la logique métier en mocking ce service.
 */
@Injectable()
export class DailySessionService {
  private readonly logger = new Logger(DailySessionService.name);

  constructor(private readonly supabase: SupabaseService) {}

  // ───────────────────────────────────────────────────────────────────
  // SESSIONS JOURNALIÈRES
  // ───────────────────────────────────────────────────────────────────

  /**
   * Récupère la session active du jour pour un portfolio.
   * Retourne null si aucune session n'existe pour la date courante.
   */
  async getCurrentSession(
    portfolioId: string,
    timezone = 'Europe/Paris',
  ): Promise<DailyTradingSession | null> {
    const sessionDate = this.getSessionDate(timezone);
    const { data, error } = await this.supabase.getClient()
      .from('daily_trading_sessions')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('session_date', sessionDate)
      .maybeSingle();

    if (error) {
      this.logger.warn(`getCurrentSession failed for ${portfolioId.slice(0, 8)}: ${error.message}`);
      return null;
    }
    return data ? this.mapRowToSession(data) : null;
  }

  /**
   * Crée une nouvelle session pour aujourd'hui.
   * Idempotent grâce à la contrainte UNIQUE (portfolio_id, session_date) :
   * si une session existe déjà, retourne celle-ci au lieu d'en créer une nouvelle.
   */
  async createOrGetTodaySession(
    portfolioId: string,
    config: DailyHarvestConfig,
  ): Promise<DailyTradingSession> {
    const existing = await this.getCurrentSession(portfolioId, config.timezone);
    if (existing) return existing;

    const sessionDate = this.getSessionDate(config.timezone);
    const { data, error } = await this.supabase.getClient()
      .from('daily_trading_sessions')
      .insert({
        portfolio_id: portfolioId,
        session_date: sessionDate,
        session_timezone: config.timezone,
        working_capital_start_usd: config.workingCapitalBaseUsd.toFixed(2),
        daily_target_amount_usd: config.dailyTargetAmountUsd?.toFixed(2) ?? null,
        daily_target_percent: config.dailyTargetPercent ?? null,
        max_loss_per_day_usd: config.maxLossPerDayUsd?.toFixed(2) ?? null,
        max_trades_per_day: config.maxTradesPerDay ?? null,
        state: 'IDLE' as HarvestState,
      })
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to create daily session: ${error?.message ?? 'unknown'}`);
    }

    this.logger.log(
      `[DAILY_HARVEST] New session created portfolio=${portfolioId.slice(0, 8)} date=${sessionDate} target=${config.dailyTargetAmountUsd ?? `${config.dailyTargetPercent}%`}`,
    );

    return this.mapRowToSession(data);
  }

  /**
   * Met à jour l'état d'une session avec audit du motif de transition.
   * IMPORTANT : ne fait PAS la validation des transitions autorisées (c'est
   * la responsabilité du DailyProfitGovernor en Phase 2).
   */
  async updateSessionState(
    sessionId: string,
    newState: HarvestState,
    reason: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase.getClient()
      .from('daily_trading_sessions')
      .update({
        state: newState,
        last_state_transition_at: now,
        last_state_transition_reason: reason.slice(0, 500),
        updated_at: now,
      })
      .eq('id', sessionId);

    if (error) {
      this.logger.warn(`updateSessionState failed for ${sessionId}: ${error.message}`);
    }
  }

  /**
   * Met à jour les métriques temps réel d'une session.
   * Appelé après chaque close de position pour rafraîchir le PnL réalisé.
   */
  async updateSessionMetrics(
    sessionId: string,
    metrics: {
      realizedPnlTodayUsd?: number;
      securedPnlTodayUsd?: number;
      unrealizedPnlNowUsd?: number;
      tradesCount?: number;
      winningTradesCount?: number;
      losingTradesCount?: number;
    },
  ): Promise<void> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (metrics.realizedPnlTodayUsd !== undefined) update.realized_pnl_today_usd = metrics.realizedPnlTodayUsd.toFixed(2);
    if (metrics.securedPnlTodayUsd !== undefined) update.secured_pnl_today_usd = metrics.securedPnlTodayUsd.toFixed(2);
    if (metrics.unrealizedPnlNowUsd !== undefined) update.unrealized_pnl_now_usd = metrics.unrealizedPnlNowUsd.toFixed(2);
    if (metrics.tradesCount !== undefined) update.trades_count = metrics.tradesCount;
    if (metrics.winningTradesCount !== undefined) update.winning_trades_count = metrics.winningTradesCount;
    if (metrics.losingTradesCount !== undefined) update.losing_trades_count = metrics.losingTradesCount;

    const { error } = await this.supabase.getClient()
      .from('daily_trading_sessions')
      .update(update)
      .eq('id', sessionId);

    if (error) {
      this.logger.warn(`updateSessionMetrics failed for ${sessionId}: ${error.message}`);
    }
  }

  /**
   * Resync session metrics depuis `lisa_positions` (source de vérité).
   *
   * Recalcule realized_pnl_today, trades_count, winning/losing depuis les
   * positions fermées aujourd'hui (UTC). Évite tout drift dû à un échec
   * silencieux du hook onTradeClosed sur un close individuel.
   *
   * Incident 27/04/2026 : LMT close à 11:55 → hook onTradeClosed silently
   * dropped → Daily Harvest affichait -$0.91 alors que portfolio réel
   * affichait -$1450. Cette méthode rend impossible ce drift en
   * dérivant les stats au lieu de les incrémenter.
   *
   * Coût : 1 SELECT par appel. Acceptable au tick close (~5-50/jour).
   * Retourne true si le resync a modifié au moins un champ.
   */
  async resyncSessionFromPositions(
    sessionId: string,
    portfolioId: string,
    sessionDate: string,
  ): Promise<boolean> {
    const dayStartUtc = new Date(`${sessionDate}T00:00:00.000Z`).toISOString();
    const dayEndUtc = new Date(new Date(dayStartUtc).getTime() + 86_400_000).toISOString();

    const { data: closes, error: selectErr } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('realized_pnl_usd, exit_timestamp, status')
      .eq('portfolio_id', portfolioId)
      .gte('exit_timestamp', dayStartUtc)
      .lt('exit_timestamp', dayEndUtc)
      .not('exit_timestamp', 'is', null);

    if (selectErr) {
      this.logger.error(`resyncSessionFromPositions select failed: ${selectErr.message}`);
      return false;
    }

    let realizedSum = 0;
    let trades = 0;
    let wins = 0;
    let losses = 0;
    for (const c of closes ?? []) {
      const pnl = parseFloat((c.realized_pnl_usd as string | null) ?? '0');
      if (!Number.isFinite(pnl)) continue;
      realizedSum += pnl;
      trades++;
      if (pnl > 0) wins++;
      else losses++;
    }

    const { error: updateErr } = await this.supabase.getClient()
      .from('daily_trading_sessions')
      .update({
        realized_pnl_today_usd: realizedSum.toFixed(2),
        trades_count: trades,
        winning_trades_count: wins,
        losing_trades_count: losses,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sessionId);

    if (updateErr) {
      this.logger.error(`resyncSessionFromPositions update failed: ${updateErr.message}`);
      return false;
    }

    return true;
  }

  /**
   * Marque une session comme fermée (état SESSION_CLOSED).
   * Appelé en fin de journée par le cron de reset.
   */
  async closeSession(sessionId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    await this.supabase.getClient()
      .from('daily_trading_sessions')
      .update({
        state: 'SESSION_CLOSED' as HarvestState,
        session_closed_at: now,
        last_state_transition_at: now,
        last_state_transition_reason: reason.slice(0, 500),
        updated_at: now,
      })
      .eq('id', sessionId);
  }

  /**
   * Liste les N dernières sessions d'un portfolio (pour historique UI).
   */
  async listRecentSessions(portfolioId: string, limit = 30): Promise<DailyTradingSession[]> {
    const { data } = await this.supabase.getClient()
      .from('daily_trading_sessions')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .order('session_date', { ascending: false })
      .limit(limit);
    return (data ?? []).map((r) => this.mapRowToSession(r));
  }

  /**
   * Statistiques cumulées (jour courant + month-to-date + records).
   * Utilisé par les cartes UI gains quotidiens / mensuels.
   *
   * Retourne :
   *  - daily : realized + secured + trades pour la session du jour
   *  - mtd   : sum sur toutes les sessions du mois courant (timezone user)
   *  - best/worst : meilleure/pire journée du mois (par realized)
   */
  async getCumulativeStats(
    portfolioId: string,
    timezone = 'Europe/Paris',
  ): Promise<{
    daily: {
      realized: number;
      secured: number;
      tradesCount: number;
      winRate: number;
    };
    mtd: {
      realized: number;
      secured: number;
      tradesCount: number;
      sessionsCount: number;
      winningDays: number;
      losingDays: number;
    };
    bestDay: { date: string; pnl: number } | null;
    worstDay: { date: string; pnl: number } | null;
  }> {
    // 1. Session du jour
    const today = await this.getCurrentSession(portfolioId, timezone);

    // 2. Toutes les sessions du mois courant (timezone user)
    const firstOfMonth = this.getFirstOfMonth(timezone);
    const { data: monthSessions } = await this.supabase.getClient()
      .from('daily_trading_sessions')
      .select('session_date, realized_pnl_today_usd, secured_pnl_today_usd, trades_count, winning_trades_count, losing_trades_count')
      .eq('portfolio_id', portfolioId)
      .gte('session_date', firstOfMonth)
      .order('session_date', { ascending: true });

    const sessions = monthSessions ?? [];

    // 3. Agrégat MTD
    let mtdRealized = 0;
    let mtdSecured = 0;
    let mtdTrades = 0;
    let winningDays = 0;
    let losingDays = 0;
    let bestDay: { date: string; pnl: number } | null = null;
    let worstDay: { date: string; pnl: number } | null = null;

    for (const s of sessions) {
      const realized = Number(s.realized_pnl_today_usd) || 0;
      const secured = Number(s.secured_pnl_today_usd) || 0;
      mtdRealized += realized;
      mtdSecured += secured;
      mtdTrades += Number(s.trades_count) || 0;
      if (realized > 0) winningDays++;
      else if (realized < 0) losingDays++;

      if (!bestDay || realized > bestDay.pnl) {
        bestDay = { date: String(s.session_date), pnl: realized };
      }
      if (!worstDay || realized < worstDay.pnl) {
        worstDay = { date: String(s.session_date), pnl: realized };
      }
    }

    // 4. Win rate du jour
    const todayWinRate = today && today.tradesCount > 0
      ? (today.winningTradesCount / today.tradesCount) * 100
      : 0;

    return {
      daily: {
        realized: today ? parseFloat(today.realizedPnlTodayUsd) : 0,
        secured: today ? parseFloat(today.securedPnlTodayUsd) : 0,
        tradesCount: today?.tradesCount ?? 0,
        winRate: todayWinRate,
      },
      mtd: {
        realized: mtdRealized,
        secured: mtdSecured,
        tradesCount: mtdTrades,
        sessionsCount: sessions.length,
        winningDays,
        losingDays,
      },
      bestDay,
      worstDay,
    };
  }

  /**
   * Retourne le 1er jour du mois courant en timezone user, format YYYY-MM-DD.
   */
  private getFirstOfMonth(timezone: string): string {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
    });
    const parts = formatter.formatToParts(now);
    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    return `${year}-${month}-01`;
  }

  // ───────────────────────────────────────────────────────────────────
  // VAULT — SECURED PROFIT BALANCE
  // ───────────────────────────────────────────────────────────────────

  /**
   * Récupère le solde sécurisé d'un portfolio.
   * Retourne un solde à 0 si le vault n'existe pas encore.
   */
  async getSecuredBalance(portfolioId: string): Promise<SecuredProfitBalance> {
    const { data } = await this.supabase.getClient()
      .from('secured_profit_balance')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    if (!data) {
      return {
        portfolioId,
        totalSecuredUsd: '0',
        sweepCount: 0,
        firstSweepAt: null,
        lastSweepAt: null,
        largestSingleSweepUsd: null,
      };
    }
    return {
      portfolioId: data.portfolio_id as string,
      totalSecuredUsd: String(data.total_secured_usd),
      sweepCount: Number(data.sweep_count),
      firstSweepAt: data.first_sweep_at as string | null,
      lastSweepAt: data.last_sweep_at as string | null,
      largestSingleSweepUsd: data.largest_single_sweep_usd as string | null,
    };
  }

  /**
   * Incrémente le vault avec un nouveau sweep.
   * Crée la ligne si elle n'existe pas (upsert idempotent).
   *
   * NOTE : pas de décrément possible — le vault est immuable de l'extérieur,
   * sauf reset admin explicite (route séparée non implémentée Phase 1).
   */
  async addToSecuredBalance(portfolioId: string, amountUsd: number): Promise<void> {
    if (amountUsd <= 0) {
      this.logger.warn(`addToSecuredBalance ignoré : montant <= 0 (${amountUsd})`);
      return;
    }

    const now = new Date().toISOString();
    const existing = await this.getSecuredBalance(portfolioId);
    const newTotal = parseFloat(existing.totalSecuredUsd) + amountUsd;
    const newCount = existing.sweepCount + 1;
    const largestSoFar = parseFloat(existing.largestSingleSweepUsd ?? '0');
    const newLargest = Math.max(largestSoFar, amountUsd);

    const { error } = await this.supabase.getClient()
      .from('secured_profit_balance')
      .upsert(
        {
          portfolio_id: portfolioId,
          total_secured_usd: newTotal.toFixed(2),
          sweep_count: newCount,
          first_sweep_at: existing.firstSweepAt ?? now,
          last_sweep_at: now,
          largest_single_sweep_usd: newLargest.toFixed(2),
          updated_at: now,
        },
        { onConflict: 'portfolio_id' },
      );

    if (error) {
      this.logger.warn(`addToSecuredBalance failed for ${portfolioId.slice(0, 8)}: ${error.message}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // CALCULS UTILITAIRES (pas d'I/O — purs)
  // ───────────────────────────────────────────────────────────────────

  /**
   * Calcule la progression vers l'objectif journalier (utilisé par UI + persona).
   * Pure function : ne touche pas la DB.
   */
  computeProgress(
    session: DailyTradingSession,
    config: DailyHarvestConfig,
  ): DailyHarvestProgress {
    // Resolve target en absolu (priorité au pourcentage si les 2 sont set)
    const workingCapital = parseFloat(session.workingCapitalStartUsd);
    let targetAmountUsd: number;
    if (config.dailyTargetPercent != null) {
      targetAmountUsd = workingCapital * (config.dailyTargetPercent / 100);
    } else if (config.dailyTargetAmountUsd != null) {
      targetAmountUsd = config.dailyTargetAmountUsd;
    } else {
      targetAmountUsd = 0; // pas de cible → mode quasi-NONE
    }

    const realized = parseFloat(session.realizedPnlTodayUsd);
    const secured = parseFloat(session.securedPnlTodayUsd);
    const remainingToTarget = targetAmountUsd - realized;
    const progressPct = targetAmountUsd > 0
      ? Math.max(0, (realized / targetAmountUsd) * 100)
      : 0;

    const tradesRemainingBeforeCap = config.maxTradesPerDay != null
      ? Math.max(0, config.maxTradesPerDay - session.tradesCount)
      : null;

    const lossRemainingBeforeLock = config.maxLossPerDayUsd != null
      ? Math.max(0, config.maxLossPerDayUsd + Math.min(0, realized))
      : null;

    const isLocked = ['DAILY_LOCKED', 'LOSS_LIMIT_HIT', 'SESSION_CLOSED'].includes(session.state);

    return {
      state: session.state,
      targetAmountUsd,
      realizedToday: realized,
      securedToday: secured,
      remainingToTarget,
      progressPct,
      tradesCount: session.tradesCount,
      tradesRemainingBeforeCap,
      lossRemainingBeforeLock,
      isLocked,
    };
  }

  /**
   * Détermine la date de session courante en timezone user.
   * Format YYYY-MM-DD pour matcher la colonne `date` PostgreSQL.
   *
   * Note : le passage de jour calendaire se fait à minuit timezone user
   * (pas à minuit UTC) — cohérent avec l'expérience utilisateur. Si
   * l'utilisateur trade à 23:59 Paris, c'est compté dans la session
   * d'aujourd'hui. À 00:01 Paris c'est déjà demain.
   */
  private getSessionDate(timezone = 'Europe/Paris'): string {
    const now = new Date();
    // Conversion vers timezone user via Intl.DateTimeFormat
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(now); // 'YYYY-MM-DD'
  }

  /**
   * Mapping row DB → DailyTradingSession TS.
   */
  private mapRowToSession(row: Record<string, unknown>): DailyTradingSession {
    return {
      id: row.id as string,
      portfolioId: row.portfolio_id as string,
      sessionDate: row.session_date as string,
      sessionTimezone: row.session_timezone as string,
      sessionStartedAt: row.session_started_at as string,
      sessionClosedAt: (row.session_closed_at as string | null) ?? null,
      workingCapitalStartUsd: String(row.working_capital_start_usd),
      dailyTargetAmountUsd: row.daily_target_amount_usd != null ? String(row.daily_target_amount_usd) : null,
      dailyTargetPercent: row.daily_target_percent as number | null,
      maxLossPerDayUsd: row.max_loss_per_day_usd != null ? String(row.max_loss_per_day_usd) : null,
      maxTradesPerDay: row.max_trades_per_day as number | null,
      state: row.state as HarvestState,
      realizedPnlTodayUsd: String(row.realized_pnl_today_usd),
      securedPnlTodayUsd: String(row.secured_pnl_today_usd),
      unrealizedPnlNowUsd: row.unrealized_pnl_now_usd != null ? String(row.unrealized_pnl_now_usd) : null,
      tradesCount: Number(row.trades_count),
      winningTradesCount: Number(row.winning_trades_count),
      losingTradesCount: Number(row.losing_trades_count),
      lastStateTransitionAt: row.last_state_transition_at as string,
      lastStateTransitionReason: (row.last_state_transition_reason as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

// Re-export pour visibilité externe
export { HARVEST_CONSTANTS };
