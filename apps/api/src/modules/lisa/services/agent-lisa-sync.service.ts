import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { DecisionLogService } from './decision-log.service';
import { LisaService } from './lisa.service';

/**
 * AgentLisaSyncService — P5.1 : boucle réflexive agent mécanique ↔ Lisa.
 *
 * L'agent mécanique tourne chaque minute sans LLM. Mais il y a des signaux
 * asymétriques qu'il ne peut pas gérer seul (regime shift, choc VIX, position
 * en détresse avant stop). Plutôt que coder des règles hardcodées pour chaque
 * cas, on "réveille" Lisa qui ré-analyse le contexte et émet de nouvelles
 * directives / tactical_overrides.
 *
 * Pattern : event-driven reflective agent (OODA loop).
 *
 * Triggers Tier 1 (wake immédiat) — P5.1 :
 *   1. Portfolio drawdown intraday < -0.8% → avant kill-switch P4.1, Lisa
 *      peut réduire exposition ou fermer la plus faible conviction
 *   2. Position unique P&L live < -3% → Lisa peut invalider la thèse ou
 *      resserrer le stop avant que le stop fixe ne déclenche
 *   3. VIX spike > 30 → choc marché, Lisa passe en posture défensive
 *
 * Budget :
 *   - Max 8 wake-ups/jour/portefeuille (évite spam coût Anthropic)
 *   - Cooldown 5 min par type de trigger (évite rafales)
 *   - Persistence : lisa_decision_log (single source of truth, pas de state
 *     volatile en mémoire qui se perd au redeploy)
 *
 * Coût attendu : ~$0.03-0.09 par wake-up → $0.50-1.00/jour/portefeuille max.
 */

const DAILY_WAKE_BUDGET = 8;
const COOLDOWN_MS_PER_TRIGGER = 5 * 60 * 1000;  // 5 min

type TriggerType =
  | 'portfolio_drawdown'
  | 'position_pnl'
  | 'vix_spike';

interface TriggerContext {
  trigger_type: TriggerType;
  trigger_value: number;
  threshold: number;
  symbol?: string;
  extra?: Record<string, unknown>;
}

@Injectable()
export class AgentLisaSyncService {
  private readonly logger = new Logger(AgentLisaSyncService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly decisionLog: DecisionLogService,
    private readonly lisa: LisaService,
  ) {}

  /**
   * Point d'entrée principal. Évalue les triggers Tier 1 pour un portefeuille
   * et réveille Lisa si conditions remplies + budget OK.
   *
   * NON-bloquant : toute erreur est loggée mais ne casse pas le cycle mécanique.
   */
  async evaluateTriggers(input: {
    portfolioId: string;
    userId: string;
    portfolioDrawdownPct: number | null;
    worstPositionPnlPct: number | null;
    worstPositionSymbol: string | null;
    vixLevel: number | null;
  }): Promise<{ woke: boolean; reason: string | null }> {
    const { portfolioId } = input;

    // 1. Détection du trigger le plus urgent (on réveille Lisa une fois par
    //    cycle, priorité à celui qui a le plus de signal)
    const trigger = this.detectHighestPriorityTrigger(input);
    if (!trigger) return { woke: false, reason: null };

    // 2. Vérifier cooldown pour ce type de trigger
    const onCooldown = await this.isOnCooldown(portfolioId, trigger.trigger_type);
    if (onCooldown) {
      this.logger.debug(
        `[P5.1] ${portfolioId.slice(0, 8)} cooldown actif sur ${trigger.trigger_type}, skip wake`,
      );
      return { woke: false, reason: 'cooldown' };
    }

    // 3. Vérifier budget journalier
    const wakeCountToday = await this.countWakesToday(portfolioId);
    if (wakeCountToday >= DAILY_WAKE_BUDGET) {
      this.logger.warn(
        `[P5.1] ${portfolioId.slice(0, 8)} budget ${DAILY_WAKE_BUDGET}/jour atteint (${wakeCountToday}), skip wake`,
      );
      return { woke: false, reason: 'budget_exhausted' };
    }

    // 4. Wake : log + invoke Lisa
    await this.wakeAndInvokeLisa(input, trigger, wakeCountToday);
    return { woke: true, reason: trigger.trigger_type };
  }

  private detectHighestPriorityTrigger(input: {
    portfolioDrawdownPct: number | null;
    worstPositionPnlPct: number | null;
    worstPositionSymbol: string | null;
    vixLevel: number | null;
  }): TriggerContext | null {
    // Priorité 1 : VIX spike (choc macro, impacte TOUT le portefeuille)
    if (input.vixLevel != null && input.vixLevel > 30) {
      return {
        trigger_type: 'vix_spike',
        trigger_value: input.vixLevel,
        threshold: 30,
      };
    }

    // Priorité 2 : drawdown portefeuille proche du kill-switch
    if (input.portfolioDrawdownPct != null && input.portfolioDrawdownPct > 0.8) {
      return {
        trigger_type: 'portfolio_drawdown',
        trigger_value: input.portfolioDrawdownPct,
        threshold: 0.8,
      };
    }

    // Priorité 3 : position unique en souffrance (P&L < -3%)
    if (
      input.worstPositionPnlPct != null &&
      input.worstPositionPnlPct < -3 &&
      input.worstPositionSymbol
    ) {
      return {
        trigger_type: 'position_pnl',
        trigger_value: input.worstPositionPnlPct,
        threshold: -3,
        symbol: input.worstPositionSymbol,
      };
    }

    return null;
  }

  private async isOnCooldown(portfolioId: string, triggerType: TriggerType): Promise<boolean> {
    const since = new Date(Date.now() - COOLDOWN_MS_PER_TRIGGER).toISOString();
    const { data } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('timestamp, payload')
      .eq('portfolio_id', portfolioId)
      .eq('kind', 'agent_wake_up_triggered')
      .gte('timestamp', since)
      .order('timestamp', { ascending: false })
      .limit(10);

    if (!data || data.length === 0) return false;

    // Si un wake récent du même trigger_type existe → cooldown actif
    return data.some(
      (row) => (row.payload as { trigger_type?: string })?.trigger_type === triggerType,
    );
  }

  private async countWakesToday(portfolioId: string): Promise<number> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .eq('kind', 'agent_wake_up_triggered')
      .gte('timestamp', todayStart.toISOString());
    return count ?? 0;
  }

  private async wakeAndInvokeLisa(
    input: { portfolioId: string; userId: string },
    trigger: TriggerContext,
    wakeCountBefore: number,
  ): Promise<void> {
    const { portfolioId, userId } = input;

    this.logger.warn(
      `[P5.1] ${portfolioId.slice(0, 8)} WAKE Lisa — trigger=${trigger.trigger_type} value=${trigger.trigger_value} (wake ${wakeCountBefore + 1}/${DAILY_WAKE_BUDGET} aujourd'hui)`,
    );

    // 1. Log hash-chaîné du wake-up (avant d'invoquer Lisa pour que le
    //    cooldown compte même si Lisa timeout)
    await this.decisionLog.append({
      portfolioId,
      kind: 'agent_wake_up_triggered',
      summary: this.summarizeTrigger(trigger),
      rationale: `[P5.1] Trigger Tier 1 "${trigger.trigger_type}" franchi (${trigger.trigger_value} vs seuil ${trigger.threshold}). Réveil Lisa pour ré-analyse contextuelle et éventuelle émission de tactical_overrides.`,
      payload: {
        trigger_type: trigger.trigger_type,
        trigger_value: trigger.trigger_value,
        threshold: trigger.threshold,
        symbol: trigger.symbol ?? null,
        wake_count_today: wakeCountBefore + 1,
        daily_budget: DAILY_WAKE_BUDGET,
      },
      triggeredBy: 'risk_monitor',
    });

    // 2. Invoque Lisa en arrière-plan (non-bloquant pour le cycle mécanique).
    //    Le userFocus renseigne le contexte d'urgence pour que Lisa adapte
    //    sa réponse (ex. émettre tactical_overrides défensifs).
    const userFocus = this.buildUserFocus(trigger);
    setImmediate(() => {
      this.lisa.generateProposal(userId, portfolioId, userFocus).catch((e) => {
        this.logger.error(
          `[P5.1] Wake Lisa invocation failed: ${String(e).slice(0, 200)}`,
        );
      });
    });
  }

  private summarizeTrigger(trigger: TriggerContext): string {
    switch (trigger.trigger_type) {
      case 'vix_spike':
        return `[P5.1] Wake Lisa — VIX ${trigger.trigger_value.toFixed(1)} > ${trigger.threshold} (choc marché)`;
      case 'portfolio_drawdown':
        return `[P5.1] Wake Lisa — drawdown portefeuille ${trigger.trigger_value.toFixed(2)}% > ${trigger.threshold}% (approche kill-switch)`;
      case 'position_pnl':
        return `[P5.1] Wake Lisa — ${trigger.symbol} P&L ${trigger.trigger_value.toFixed(2)}% < ${trigger.threshold}% (position en souffrance)`;
    }
  }

  private buildUserFocus(trigger: TriggerContext): string {
    switch (trigger.trigger_type) {
      case 'vix_spike':
        return `WAKE-UP AGENT: VIX=${trigger.trigger_value.toFixed(1)} > 30 (choc marché). Évalue urgemment la posture de risque du portefeuille et émets des tactical_overrides défensifs si pertinent (pauseOpens, tightenStopsMultiplier < 1, minConvictionOverride élevé).`;
      case 'portfolio_drawdown':
        return `WAKE-UP AGENT: drawdown intraday ${trigger.trigger_value.toFixed(2)}% approche le kill-switch (1%). Examine les positions ouvertes et propose soit (a) tactical_overrides pour fermer plus basse conviction, soit (b) fermetures explicites dans close_conditions si une thèse n'est plus valide.`;
      case 'position_pnl':
        return `WAKE-UP AGENT: position ${trigger.symbol} à ${trigger.trigger_value.toFixed(2)}% P&L. Réévalue la thèse : si invalidée, émets un close_conditions immediate ; sinon, maintiens et laisse le stop ATR faire son travail.`;
    }
  }
}
