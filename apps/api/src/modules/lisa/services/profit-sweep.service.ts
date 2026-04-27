import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { SupabaseService } from '../../supabase/supabase.service';
import { DecisionLogService } from './decision-log.service';
import { DailySessionService } from './daily-session.service';
import type { DailyTradingSession, DailyHarvestConfig } from '../types/capital-discipline.types';

/**
 * ProfitSweepService — Phase 2 DAILY_HARVEST.
 *
 * Responsabilité unique : transférer un montant de profit du capital de
 * trading vers le vault `secured_profit_balance`. Pas de state machine,
 * pas de check de target — c'est la responsabilité du DailyProfitGovernor.
 *
 * Deux modes de sweep :
 *  - PER_TRADE  : appelé après chaque close de position gagnante
 *  - END_OF_DAY : appelé une fois en fin de journée (sessionEndTime)
 *
 * Garanties :
 *  - Idempotence : un trade ne peut être sweepé qu'une seule fois (check
 *    via decision_log.kind='daily_harvest_profit_swept' avec position_id
 *    en payload)
 *  - Audit hash-chained : chaque sweep produit une entrée decision_log
 *  - Compatible avec MANUAL/HYBRID/AUTONOMOUS (pas de garde-fou actif ici,
 *    le governor décide du moment du sweep selon le DelegationMode)
 */
@Injectable()
export class ProfitSweepService {
  private readonly logger = new Logger(ProfitSweepService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly decisionLog: DecisionLogService,
    private readonly dailySession: DailySessionService,
  ) {}

  // ───────────────────────────────────────────────────────────────────
  // SWEEP PER_TRADE
  // ───────────────────────────────────────────────────────────────────

  /**
   * Sweep PER_TRADE — appelé après chaque close de position gagnante.
   *
   * @param session Session journalière courante (doit être en état actif)
   * @param positionId ID de la position fermée
   * @param symbol Symbole tradé (pour audit)
   * @param profitUsd Profit net réalisé (déjà après coûts, > 0)
   * @returns true si le sweep a été effectué, false si idempotence ou skip
   */
  async sweepTradeProfit(
    session: DailyTradingSession,
    positionId: string,
    symbol: string,
    profitUsd: number,
  ): Promise<boolean> {
    if (profitUsd <= 0) {
      this.logger.debug(`[DAILY_HARVEST] sweepTradeProfit skip ${symbol}: profit=${profitUsd}`);
      return false;
    }

    // Idempotence : a-t-on déjà sweepé ce trade ?
    const alreadySwept = await this.isPositionAlreadySwept(session.portfolioId, positionId);
    if (alreadySwept) {
      this.logger.warn(`[DAILY_HARVEST] sweepTradeProfit double-call detected for position=${positionId.slice(0, 8)} — skip`);
      return false;
    }

    // 1. Crédit vault (immutable, jamais décrémenté)
    await this.dailySession.addToSecuredBalance(session.portfolioId, profitUsd);

    // 2. Mise à jour des métriques de la session courante
    const newSecured = parseFloat(session.securedPnlTodayUsd) + profitUsd;
    await this.dailySession.updateSessionMetrics(session.id, {
      securedPnlTodayUsd: newSecured,
    });

    // 3. Audit decision_log (hash-chained, idempotent par UUID position)
    await this.decisionLog.append({
      portfolioId: session.portfolioId,
      kind: 'daily_harvest_profit_swept',
      summary: `Sweep PER_TRADE ${symbol}: +$${profitUsd.toFixed(2)} → vault (cumul jour: $${newSecured.toFixed(2)})`,
      rationale: `Mode DAILY_HARVEST PER_TRADE: profit réalisé ${symbol} transféré du capital de trading vers secured_profit_balance. Vault non réinjectable dans les décisions futures (preservation discipline).`,
      payload: {
        positionId,
        symbol,
        profitUsd: profitUsd.toFixed(2),
        sessionId: session.id,
        sweepMode: 'PER_TRADE',
        cumulSweepedToday: newSecured.toFixed(2),
      },
      triggeredBy: 'autopilot_cron',
    }).catch((e) => {
      this.logger.warn(`decision log append failed for sweep ${symbol}: ${String(e).slice(0, 100)}`);
    });

    this.logger.log(
      `[DAILY_HARVEST] PER_TRADE sweep ${symbol} +$${profitUsd.toFixed(2)} (vault total session: $${newSecured.toFixed(2)})`,
    );
    return true;
  }

  // ───────────────────────────────────────────────────────────────────
  // SWEEP END_OF_DAY
  // ───────────────────────────────────────────────────────────────────

  /**
   * Sweep END_OF_DAY — appelé une fois en fin de session.
   * Sweepe TOUS les profits réalisés du jour qui n'ont pas encore été
   * sweepés (en mode END_OF_DAY uniquement, sinon les sweeps PER_TRADE
   * couvrent déjà tout).
   *
   * Le montant à sweeper = realized_pnl_today_usd - secured_pnl_today_usd
   * (= la différence pas encore sécurisée).
   *
   * @param session Session journalière en fin de journée
   * @returns Montant sweepé (0 si rien à faire ou perte journalière)
   */
  async sweepEndOfDay(session: DailyTradingSession): Promise<number> {
    const realized = parseFloat(session.realizedPnlTodayUsd);
    const alreadySecured = parseFloat(session.securedPnlTodayUsd);
    const toSweep = realized - alreadySecured;

    // Pas de sweep si :
    // - Realized négatif (journée en perte) — on ne sécurise pas une perte
    // - toSweep <= 0 (déjà tout sweepé en PER_TRADE)
    if (realized <= 0 || toSweep <= 0) {
      this.logger.debug(
        `[DAILY_HARVEST] sweepEndOfDay skip session=${session.id.slice(0, 8)}: realized=${realized}, alreadySecured=${alreadySecured}, toSweep=${toSweep}`,
      );
      return 0;
    }

    // 1. Crédit vault
    await this.dailySession.addToSecuredBalance(session.portfolioId, toSweep);

    // 2. Mise à jour métriques session
    await this.dailySession.updateSessionMetrics(session.id, {
      securedPnlTodayUsd: realized, // tout est sécurisé maintenant
    });

    // 3. Audit
    await this.decisionLog.append({
      portfolioId: session.portfolioId,
      kind: 'daily_harvest_profit_swept',
      summary: `Sweep END_OF_DAY: +$${toSweep.toFixed(2)} → vault (session ${session.sessionDate})`,
      rationale: `Mode DAILY_HARVEST END_OF_DAY: tous les profits journaliers non encore sweepés transférés au vault en fin de session. Realized total: $${realized.toFixed(2)}, deja sécurisé: $${alreadySecured.toFixed(2)}, transferé: $${toSweep.toFixed(2)}.`,
      payload: {
        sessionId: session.id,
        sessionDate: session.sessionDate,
        realizedToday: realized.toFixed(2),
        alreadySecured: alreadySecured.toFixed(2),
        sweptNow: toSweep.toFixed(2),
        sweepMode: 'END_OF_DAY',
      },
      triggeredBy: 'autopilot_cron',
    }).catch((e) => {
      this.logger.warn(`decision log append failed for end-of-day sweep: ${String(e).slice(0, 100)}`);
    });

    this.logger.log(
      `[DAILY_HARVEST] END_OF_DAY sweep portfolio=${session.portfolioId.slice(0, 8)} +$${toSweep.toFixed(2)}`,
    );
    return toSweep;
  }

  // ───────────────────────────────────────────────────────────────────
  // SWEEP MANUEL (déclenché par user via UI/API)
  // ───────────────────────────────────────────────────────────────────

  /**
   * Sweep manuel — déclenché explicitement par l'utilisateur.
   * Fonctionne quel que soit le mode (PER_TRADE / END_OF_DAY).
   *
   * @param session Session courante
   * @param amountUsd Montant à sweeper (max = realized - alreadySecured)
   * @param reason Motif libre saisi par user
   */
  async sweepManual(
    session: DailyTradingSession,
    amountUsd: number,
    reason: string,
  ): Promise<{ swept: number; remaining: number }> {
    const realized = parseFloat(session.realizedPnlTodayUsd);
    const alreadySecured = parseFloat(session.securedPnlTodayUsd);
    const maxAvailable = realized - alreadySecured;

    if (maxAvailable <= 0) {
      throw new Error(`Aucun profit disponible à sweeper (realized=${realized}, déjà sécurisé=${alreadySecured})`);
    }

    const sweptAmount = Math.min(amountUsd, maxAvailable);
    if (sweptAmount <= 0) {
      throw new Error(`Montant invalide: ${amountUsd}`);
    }

    await this.dailySession.addToSecuredBalance(session.portfolioId, sweptAmount);
    await this.dailySession.updateSessionMetrics(session.id, {
      securedPnlTodayUsd: alreadySecured + sweptAmount,
    });

    await this.decisionLog.append({
      portfolioId: session.portfolioId,
      kind: 'daily_harvest_manual_sweep',
      summary: `Sweep manuel user: +$${sweptAmount.toFixed(2)} → vault`,
      rationale: `Sweep déclenché manuellement par l'utilisateur. Motif: ${reason.slice(0, 200)}`,
      payload: {
        sessionId: session.id,
        sweptAmount: sweptAmount.toFixed(2),
        userReason: reason.slice(0, 500),
      },
      triggeredBy: 'user_manual',
    }).catch((e) => {
      this.logger.warn(`decision log append failed for manual sweep: ${String(e).slice(0, 100)}`);
    });

    return {
      swept: sweptAmount,
      remaining: maxAvailable - sweptAmount,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // HELPERS
  // ───────────────────────────────────────────────────────────────────

  /**
   * Vérifie si une position a déjà été sweepée (idempotence).
   * Lit le decision_log pour cette position.
   */
  private async isPositionAlreadySwept(portfolioId: string, positionId: string): Promise<boolean> {
    const { data } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('id')
      .eq('portfolio_id', portfolioId)
      .eq('kind', 'daily_harvest_profit_swept')
      .filter('payload->>positionId', 'eq', positionId)
      .limit(1)
      .maybeSingle();
    return !!data;
  }

  /**
   * Calcule le profit net d'un trade (entry - exit - costs).
   * Utilité : permet au caller (governor) de calculer profit avant d'appeler sweep.
   * Pure function : pas d'I/O.
   */
  computeTradeProfitUsd(params: {
    direction: string;
    entryPrice: string;
    exitPrice: string;
    quantity: string;
    entryNotionalUsd: string;
  }): number {
    const entry = new Decimal(params.entryPrice);
    const exit = new Decimal(params.exitPrice);
    const qty = new Decimal(params.quantity);
    const isLong = params.direction === 'long' || params.direction === 'long_call' || params.direction === 'long_put';

    const priceDelta = isLong ? exit.minus(entry) : entry.minus(exit);
    const grossPnl = priceDelta.mul(qty);

    // Coûts entry+exit ~10 bps chacun (cohérent avec paper-broker.service.ts:91,191)
    const entryNotional = new Decimal(params.entryNotionalUsd);
    const exitNotional = exit.mul(qty);
    const totalCosts = entryNotional.mul(10).dividedBy(10000).plus(
      exitNotional.mul(10).dividedBy(10000),
    );

    return grossPnl.minus(totalCosts).toNumber();
  }
}
