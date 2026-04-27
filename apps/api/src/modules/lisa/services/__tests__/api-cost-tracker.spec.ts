import { BudgetExceededError } from '../api-cost-tracker.service';

/**
 * PATCH 4 (PR#4 P1) — BudgetExceededError + comportement attendu.
 *
 * Le hard-stop côté lisa.service.generateProposal :
 *   1. Lit ApiCostTrackerService.getTodayTotalUsd()
 *   2. Si >= dailyCostBudgetUsd → désactive autopilot + throw
 *
 * Test focal : forme de l'erreur (props lisibles + héritage Error). Test
 * integration full lisa.service reporté (cf. PATCH 1) — nécessite mock
 * Supabase chain complet.
 */
describe('BudgetExceededError', () => {
  it('carries todayCostUsd and budgetUsd', () => {
    const err = new BudgetExceededError(25.5, 20);
    expect(err.todayCostUsd).toBe(25.5);
    expect(err.budgetUsd).toBe(20);
    expect(err.name).toBe('BudgetExceededError');
  });

  it('produces a readable message with both values', () => {
    const err = new BudgetExceededError(25.5, 20);
    expect(err.message).toContain('25.50');
    expect(err.message).toContain('20.00');
    expect(err.message).toContain('BUDGET_EXCEEDED');
  });

  it('is an instance of Error (catchable)', () => {
    const err = new BudgetExceededError(30, 20);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BudgetExceededError);
  });
});
