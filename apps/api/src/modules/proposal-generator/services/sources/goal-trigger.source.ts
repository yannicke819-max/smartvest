import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../../supabase/supabase.service';
import type { RawProposal } from '../../interfaces/raw-proposal';

@Injectable()
export class GoalTriggerSource {
  constructor(private readonly supabase: SupabaseService) {}

  async detect(portfolioId: string, userId: string): Promise<RawProposal[]> {
    const proposals: RawProposal[] = [];
    const today = new Date().toISOString().slice(0, 10);

    // Active goals for this portfolio
    const { data: goals } = await this.supabase.getClient()
      .from('goals')
      .select('id, name, target_amount, currency, monthly_contribution, horizon_months, active_plan_id')
      .eq('portfolio_id', portfolioId)
      .eq('user_id', userId)
      .eq('status', 'active');

    if (!goals?.length) return [];

    for (const goal of goals as Array<Record<string, unknown>>) {
      const goalId = goal['id'] as string;

      // Check latest feasibility — if not credible, suggest review
      const { data: feasibility } = await this.supabase.getClient()
        .from('feasibility_assessments')
        .select('is_credible, credibility_score, tensions')
        .eq('goal_id', goalId)
        .order('assessed_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (feasibility && !(feasibility as Record<string, unknown>)['is_credible']) {
        const tensions = (feasibility as Record<string, unknown>)['tensions'];
        const tensionList = Array.isArray(tensions)
          ? tensions.join(', ')
          : typeof tensions === 'string'
          ? tensions
          : '';
        proposals.push({
          action: 'contribute',
          currency: (goal['currency'] as string) ?? 'EUR',
          rationale: `L'objectif "${goal['name'] as string}" est hors trajectoire (score de crédibilité faible). Tensions détectées : ${tensionList || 'voir analyse de faisabilité'}.`,
          assumptions: [
            `Horizon : ${goal['horizon_months'] as number} mois`,
            `Versement mensuel actuel : ${goal['monthly_contribution'] as string} ${goal['currency'] as string}`,
            'Basé sur l\'analyse de faisabilité la plus récente',
          ],
          sourceKind: 'goal_trigger',
          sourceId: goalId,
          score: 0.75,
          expiresInDays: 14,
          dedupKey: `goal_offtrack:${portfolioId}:${goalId}`,
        });
      }

      // Pending plan action candidates
      if (goal['active_plan_id']) {
        const { data: steps } = await this.supabase.getClient()
          .from('objective_plan_steps')
          .select('id, action_kind, target_date')
          .eq('plan_id', goal['active_plan_id'] as string)
          .lte('target_date', today);

        if (steps?.length) {
          for (const step of steps as Array<Record<string, unknown>>) {
            const { data: candidates } = await this.supabase.getClient()
              .from('plan_action_candidates')
              .select('id, kind, ticker, amount, rationale')
              .eq('step_id', step['id'] as string)
              .eq('status', 'pending')
              .limit(1);

            if (!candidates?.length) continue;
            const c = candidates[0] as Record<string, unknown>;

            const action = mapCandidateAction(c['kind'] as string);
            const ticker = c['ticker'] as string | null;
            const notional = c['amount'] as string | null;
            proposals.push({
              action,
              ...(ticker ? { ticker } : {}),
              ...(notional ? { notional } : {}),
              currency: (goal['currency'] as string) ?? 'EUR',
              rationale: (c['rationale'] as string) || `Action du plan "${goal['name'] as string}" à réaliser (${c['kind'] as string}).`,
              assumptions: [
                `Objectif : ${goal['name'] as string}`,
                `Étape prévue au ${step['target_date'] as string}`,
                'Issu du plan d\'action généré automatiquement',
              ],
              sourceKind: 'goal_trigger',
              sourceId: goalId,
              score: 0.55,
              expiresInDays: 7,
              dedupKey: `plan_candidate:${portfolioId}:${goalId}:${c['id'] as string}`,
            });
          }
        }
      }

      // Overdue review checkpoints
      const { data: checkpoints } = await this.supabase.getClient()
        .from('objective_review_checkpoints')
        .select('id, title, scheduled_at')
        .eq('plan_id', goal['active_plan_id'] as string ?? '')
        .lte('scheduled_at', today)
        .is('completed_at', null)
        .limit(1);

      if (checkpoints?.length) {
        const cp = checkpoints[0] as Record<string, unknown>;
        proposals.push({
          action: 'other',
          currency: (goal['currency'] as string) ?? 'EUR',
          rationale: `Revue de portefeuille prévue pour l'objectif "${goal['name'] as string}" est en retard (${cp['title'] as string}, prévue le ${cp['scheduled_at'] as string}).`,
          assumptions: [
            `Objectif : ${goal['name'] as string}`,
            `Revue prévue le : ${cp['scheduled_at'] as string}`,
          ],
          sourceKind: 'goal_trigger',
          sourceId: goalId,
          score: 0.50,
          expiresInDays: 14,
          dedupKey: `checkpoint_overdue:${portfolioId}:${cp['id'] as string}`,
        });
      }
    }

    return proposals;
  }
}

function mapCandidateAction(
  kind: string,
): 'buy' | 'sell' | 'rebalance' | 'contribute' | 'withdraw' | 'other' {
  const map: Record<string, 'buy' | 'sell' | 'rebalance' | 'contribute' | 'withdraw' | 'other'> = {
    contribute: 'contribute',
    buy: 'buy',
    sell: 'sell',
    rebalance: 'rebalance',
    withdraw: 'withdraw',
  };
  return map[kind] ?? 'other';
}
