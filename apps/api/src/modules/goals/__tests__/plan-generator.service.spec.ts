import { PlanGeneratorService } from '../services/plan-generator.service';

describe('PlanGeneratorService', () => {
  const svc = new PlanGeneratorService();

  const allocation = { equity: 0.6, bonds: 0.3, cash: 0.1 };

  it('generates a plan with steps and checkpoints', () => {
    const plan = svc.generate('goal-1', 'scenario-1', 60, '500', allocation);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.checkpoints.length).toBeGreaterThan(0);
  });

  it('first step is contribution setup', () => {
    const plan = svc.generate('goal-1', 'scenario-1', 60, '500', allocation);
    expect(plan.steps[0].actionKind).toBe('contribution_setup');
    expect(plan.steps[0].order).toBe(1);
  });

  it('second step is allocation rebalance', () => {
    const plan = svc.generate('goal-1', 'scenario-1', 60, '500', allocation);
    expect(plan.steps[1].actionKind).toBe('allocation_rebalance');
  });

  it('contribution step has action candidate with correct amount', () => {
    const plan = svc.generate('goal-1', 'scenario-1', 60, '750.00', allocation);
    const step1 = plan.steps[0];
    const candidate = step1.actionCandidates[0];
    expect(candidate).toBeDefined();
    expect(candidate.kind).toBe('contribute');
    expect(candidate.amount).toBe('750.00');
  });

  it('uses MANUAL_EXPLICIT as default delegation mode', () => {
    const plan = svc.generate('goal-1', 'scenario-1', 60, '500', allocation);
    expect(plan.delegationMode).toBe('MANUAL_EXPLICIT');
    const candidate = plan.steps[0].actionCandidates[0];
    expect(candidate.delegationMode).toBe('MANUAL_EXPLICIT');
  });

  it('respects custom delegation mode', () => {
    const plan = svc.generate('goal-1', 'scenario-1', 60, '500', allocation, 'HYBRID_SUGGESTIVE');
    expect(plan.delegationMode).toBe('HYBRID_SUGGESTIVE');
  });

  it('last step targets the horizon date', () => {
    const horizonMonths = 36;
    const plan = svc.generate('goal-1', 'scenario-1', horizonMonths, '500', allocation);
    const lastStep = plan.steps[plan.steps.length - 1];
    expect(lastStep.targetDate).not.toBeNull();
  });
});
