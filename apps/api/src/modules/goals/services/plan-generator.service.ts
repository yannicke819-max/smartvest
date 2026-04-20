import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import type { ObjectivePlan, ObjectivePlanStep, ObjectiveReviewCheckpoint, PlanActionCandidate } from '@smartvest/domain';

function addMonths(date: Date, n: number): string {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class PlanGeneratorService {
  generate(
    goalId: string,
    scenarioId: string,
    horizonMonths: number,
    monthlyContribution: string,
    suggestedAllocation: Record<string, number>,
    delegationMode: 'MANUAL_EXPLICIT' | 'HYBRID_SUGGESTIVE' | 'AUTONOMOUS_GUARDED' = 'MANUAL_EXPLICIT',
  ): Omit<ObjectivePlan, 'id' | 'createdAt' | 'updatedAt'> & { steps: ObjectivePlanStep[]; checkpoints: ObjectiveReviewCheckpoint[] } {
    const now = new Date();
    const planId = uuid();

    const steps: ObjectivePlanStep[] = [];
    const checkpoints: ObjectiveReviewCheckpoint[] = [];

    // Step 1: Set up contribution
    const step1Id = uuid();
    const contributionAction: PlanActionCandidate = {
      id: uuid(),
      stepId: step1Id,
      kind: 'contribute',
      ticker: null,
      isin: null,
      amount: monthlyContribution,
      quantity: null,
      rationale: `Mettre en place un virement automatique de ${monthlyContribution} €/mois vers le portefeuille objectif.`,
      delegationMode,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    steps.push({
      id: step1Id,
      planId,
      order: 1,
      title: 'Mise en place des versements',
      description: `Programmer un versement mensuel régulier de ${monthlyContribution} € pour alimenter l'objectif.`,
      actionKind: 'contribution_setup',
      targetDate: addMonths(now, 1),
      completedAt: null,
      actionCandidates: [contributionAction],
    });

    // Step 2: Set up allocation
    const step2Id = uuid();
    const allocationDesc = Object.entries(suggestedAllocation)
      .map(([k, v]) => `${k}: ${(v * 100).toFixed(0)}%`)
      .join(', ');
    const rebalanceAction: PlanActionCandidate = {
      id: uuid(),
      stepId: step2Id,
      kind: 'rebalance',
      ticker: null,
      isin: null,
      amount: null,
      quantity: null,
      rationale: `Aligner le portefeuille sur l'allocation cible : ${allocationDesc}`,
      delegationMode,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    steps.push({
      id: step2Id,
      planId,
      order: 2,
      title: 'Allocation initiale',
      description: `Structurer le portefeuille selon l'allocation recommandée par le scénario : ${allocationDesc}.`,
      actionKind: 'allocation_rebalance',
      targetDate: addMonths(now, 1),
      completedAt: null,
      actionCandidates: [rebalanceAction],
    });

    // Step 3: Intermediate reviews (every 12 months or at key milestones)
    const reviewIntervalMonths = horizonMonths > 24 ? 12 : Math.max(3, Math.floor(horizonMonths / 3));
    let reviewMonth = reviewIntervalMonths;
    let reviewOrder = 3;
    const reviewTriggerIds: string[] = [];

    while (reviewMonth < horizonMonths) {
      const stepId = uuid();
      steps.push({
        id: stepId,
        planId,
        order: reviewOrder++,
        title: `Revue à ${reviewMonth} mois`,
        description: 'Vérifier l\'avancement de l\'objectif, ajuster les versements si nécessaire, et contrôler la dérive d\'allocation.',
        actionKind: 'review',
        targetDate: addMonths(now, reviewMonth),
        completedAt: null,
        actionCandidates: [],
      });
      reviewTriggerIds.push(stepId);
      reviewMonth += reviewIntervalMonths;
    }

    // Step N: Final step
    const finalStepId = uuid();
    steps.push({
      id: finalStepId,
      planId,
      order: reviewOrder,
      title: 'Clôture ou réorientation',
      description: 'Évaluer l\'atteinte de l\'objectif, décider de clôturer, réorienter le capital ou prolonger l\'horizon.',
      actionKind: 'monitoring',
      targetDate: addMonths(now, horizonMonths),
      completedAt: null,
      actionCandidates: [],
    });

    // Checkpoints: one per year + final
    const checkpointIntervalMonths = Math.min(12, Math.max(3, Math.floor(horizonMonths / 4)));
    let cpMonth = checkpointIntervalMonths;
    while (cpMonth <= horizonMonths) {
      checkpoints.push({
        id: uuid(),
        planId,
        scheduledAt: addMonths(now, cpMonth),
        title: cpMonth >= horizonMonths ? 'Bilan final' : `Point de contrôle — M+${cpMonth}`,
        description: cpMonth >= horizonMonths
          ? 'Évaluation finale de l\'objectif et décision de clôture.'
          : `Vérifier la trajectoire, la dérive d'allocation, et l'adéquation des versements après ${cpMonth} mois.`,
        triggerIds: reviewTriggerIds.slice(0, Math.ceil(cpMonth / reviewIntervalMonths)),
        completedAt: null,
        outcome: null,
        notes: null,
      });
      if (cpMonth >= horizonMonths) break;
      cpMonth = Math.min(cpMonth + checkpointIntervalMonths, horizonMonths);
    }

    return {
      goalId,
      scenarioId,
      status: 'draft',
      delegationMode,
      steps,
      checkpoints,
      selectedAt: now.toISOString(),
    };
  }
}
