import { FeasibilityService } from '../services/feasibility.service';

describe('FeasibilityService', () => {
  const svc = new FeasibilityService();

  it('marks credible goal as credible', () => {
    const result = svc.assess({
      goalId: 'goal-1',
      targetAmount: '50000',
      currentAmount: '10000',
      monthlyContribution: '500',
      horizonMonths: 84, // 7 years
    });
    expect(result.isCredible).toBe(true);
    expect(result.credibilityScore).toBeGreaterThan(0.35);
  });

  it('marks unrealistic goal as not credible', () => {
    const result = svc.assess({
      goalId: 'goal-2',
      targetAmount: '1000000',
      currentAmount: '1000',
      monthlyContribution: '100',
      horizonMonths: 24,
    });
    expect(result.isCredible).toBe(false);
    expect(result.tensions.length).toBeGreaterThan(0);
  });

  it('detects horizon_too_short tension', () => {
    const result = svc.assess({
      goalId: 'goal-3',
      targetAmount: '10000',
      currentAmount: '0',
      monthlyContribution: '1000',
      horizonMonths: 3,
    });
    expect(result.tensions).toContain('horizon_too_short');
  });

  it('detects contribution_insufficient tension', () => {
    const result = svc.assess({
      goalId: 'goal-4',
      targetAmount: '500000',
      currentAmount: '0',
      monthlyContribution: '100',
      horizonMonths: 120,
    });
    expect(result.tensions).toContain('contribution_insufficient');
    const lever = result.levers.find((l: { kind: string }) => l.kind === 'increase_contribution');
    expect(lever).toBeDefined();
  });

  it('detects risk_profile_mismatch for conservative profile', () => {
    const result = svc.assess({
      goalId: 'goal-5',
      targetAmount: '200000',
      currentAmount: '0',
      monthlyContribution: '200',
      horizonMonths: 60,
      riskProfile: 'conservative',
    });
    expect(result.tensions).toContain('risk_profile_mismatch');
  });

  it('returns implied annual return as string', () => {
    const result = svc.assess({
      goalId: 'goal-6',
      targetAmount: '20000',
      currentAmount: '5000',
      monthlyContribution: '200',
      horizonMonths: 60,
    });
    expect(typeof result.impliedAnnualReturnRequired).toBe('string');
    expect(parseFloat(result.impliedAnnualReturnRequired)).not.toBeNaN();
  });
});
