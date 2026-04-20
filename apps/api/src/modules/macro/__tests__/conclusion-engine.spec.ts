import { ConclusionEngineService } from '../services/conclusion-engine.service';

describe('ConclusionEngineService', () => {
  const svc = new ConclusionEngineService();

  it('generates a conclusion with expected fields', () => {
    const c = svc.generate('signal-1', 'central_bank_decision', 'warning', 'medium', null, []);
    expect(c.signalId).toBe('signal-1');
    expect(c.summaryText).toBeTruthy();
    expect(c.probableScenario).toBeTruthy();
    expect(c.mainRisk).toBeTruthy();
    expect(c.counterArguments.length).toBeGreaterThan(0);
  });

  it('defaults to MANUAL_EXPLICIT delegation mode', () => {
    const c = svc.generate('s1', 'market_stress', 'critical', 'high', null, []);
    expect(c.delegationMode).toBe('MANUAL_EXPLICIT');
  });

  it('marks needsReview true for warning/critical/systemic', () => {
    for (const severity of ['warning', 'critical', 'systemic'] as const) {
      const c = svc.generate('s', `market_stress`, severity, 'medium', null, []);
      expect(c.needsReview).toBe(true);
    }
  });

  it('does not mark needsReview for info severity', () => {
    const c = svc.generate('s', 'inflation_data', 'info', 'low', null, []);
    expect(c.needsReview).toBe(false);
  });

  it('includes disclaimer in proposed actions', () => {
    const c = svc.generate('s', 'geopolitical_tension', 'critical', 'high', null, []);
    const hasDisclaimer = c.proposedActions.some((a: string) => a.includes('validation utilisateur'));
    expect(hasDisclaimer).toBe(true);
  });

  it('summary text contains category and severity', () => {
    const c = svc.generate('s', 'geopolitical_tension', 'critical', 'medium', null, []);
    expect(c.summaryText).toContain('geopolitical_tension');
    expect(c.summaryText).toContain('critical');
  });

  it('never contains forbidden wording', () => {
    const c = svc.generate('s', 'central_bank_decision', 'warning', 'high', null, []);
    const allText = [c.summaryText, c.probableScenario, c.mainRisk, ...c.proposedActions].join(' ');
    expect(allText).not.toMatch(/rendement garanti|sans risque|guaranteed return/i);
    expect(allText).not.toMatch(/you should buy|notre recommandation/i);
  });

  it('always adds "performances passées" disclaimer in counter-arguments', () => {
    const c = svc.generate('s', 'fx_move', 'watch', 'medium', null, []);
    const hasDisclaimer = c.counterArguments.some((a: string) => a.includes('performances passées'));
    expect(hasDisclaimer).toBe(true);
  });
});
