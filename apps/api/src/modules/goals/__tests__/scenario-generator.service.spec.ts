import { ScenarioGeneratorService } from '../services/scenario-generator.service';

describe('ScenarioGeneratorService', () => {
  const svc = new ScenarioGeneratorService();

  it('generates 3 scenarios', () => {
    const scenarios = svc.generate('goal-1', '100000', '10000', '500', 120);
    expect(scenarios).toHaveLength(3);
  });

  it('returns prudent, central, ambitieux types', () => {
    const scenarios = svc.generate('goal-1', '100000', '10000', '500', 120);
    const types = scenarios.map((s) => s.scenarioType).sort();
    expect(types).toEqual(['ambitieux', 'central', 'prudent']);
  });

  it('ambitieux has highest projected value', () => {
    const scenarios = svc.generate('goal-1', '100000', '10000', '500', 120);
    const map = Object.fromEntries(scenarios.map((s) => [s.scenarioType, parseFloat(s.projectedFinalValue)]));
    expect(map.ambitieux).toBeGreaterThan(map.central);
    expect(map.central).toBeGreaterThan(map.prudent);
  });

  it('each scenario has non-empty trajectory', () => {
    const scenarios = svc.generate('goal-1', '100000', '10000', '500', 60);
    for (const s of scenarios) {
      expect(s.trajectory.length).toBeGreaterThan(1);
      expect(s.trajectory[0].month).toBe(0);
    }
  });

  it('each scenario includes assumption disclaimers', () => {
    const scenarios = svc.generate('goal-1', '100000', '10000', '500', 60);
    for (const s of scenarios) {
      const hasDisclaimer = s.assumptions.some((a: string) => a.includes('performances passées'));
      expect(hasDisclaimer).toBe(true);
    }
  });

  it('shortfall is negative when projection falls short', () => {
    // Very short horizon, low contribution
    const scenarios = svc.generate('goal-1', '1000000', '1000', '100', 12);
    const prudent = scenarios.find((s) => s.scenarioType === 'prudent')!;
    expect(parseFloat(prudent.shortfallOrSurplus)).toBeLessThan(0);
  });
});
