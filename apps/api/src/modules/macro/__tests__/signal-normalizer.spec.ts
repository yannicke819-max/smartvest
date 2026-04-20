import { SignalNormalizerService } from '../services/signal-normalizer.service';

describe('SignalNormalizerService', () => {
  const svc = new SignalNormalizerService();

  it('normalizes a minimal input', () => {
    const result = svc.normalize({ title: 'Fed hike 50bp', category: 'central_bank_decision', sourceName: 'Manual' });
    expect(result.category).toBe('central_bank_decision');
    expect(result.title).toBe('Fed hike 50bp');
    expect(result.severity).toBe('info');
    expect(result.confidence).toBe('medium');
    expect(result.impactHorizon).toBe('short_term');
  });

  it('coerces unknown severity to info', () => {
    const result = svc.normalize({ title: 'X', category: 'inflation_data', sourceName: 'S', severity: 'extreme' });
    expect(result.severity).toBe('info');
  });

  it('resolves alias "cpi" to inflation_data', () => {
    const result = svc.normalize({ title: 'CPI report', category: 'cpi', sourceName: 'BLS' });
    expect(result.category).toBe('inflation_data');
  });

  it('resolves alias "fed rate" to central_bank_decision', () => {
    const result = svc.normalize({ title: 'Fed rate', category: 'fed rate decision', sourceName: 'Fed' });
    expect(result.category).toBe('central_bank_decision');
  });

  it('falls back to market_stress for unknown category', () => {
    const result = svc.normalize({ title: 'X', category: 'something_unknown_xyz', sourceName: 'X' });
    expect(result.category).toBe('market_stress');
  });

  it('sets ingestedAt to current time', () => {
    const before = Date.now();
    const result = svc.normalize({ title: 'T', category: 'fx_move', sourceName: 'S' });
    const after = Date.now();
    const ingestedMs = new Date(result.ingestedAt).getTime();
    expect(ingestedMs).toBeGreaterThanOrEqual(before);
    expect(ingestedMs).toBeLessThanOrEqual(after);
  });

  it('truncates title to 500 characters', () => {
    const long = 'A'.repeat(600);
    const result = svc.normalize({ title: long, category: 'growth_data', sourceName: 'S' });
    expect(result.title.length).toBeLessThanOrEqual(500);
  });

  it('populates geographic zones and sectors from input', () => {
    const result = svc.normalize({
      title: 'Macro event',
      category: 'geopolitical_tension',
      sourceName: 'Reuters',
      geographicZones: ['EU', 'ME'],
      affectedSectors: ['energy', 'defense'],
    });
    expect(result.geographicZones).toEqual(['EU', 'ME']);
    expect(result.affectedSectors).toEqual(['energy', 'defense']);
  });
});
