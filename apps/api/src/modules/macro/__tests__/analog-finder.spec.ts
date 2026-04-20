import { AnalogFinderService } from '../services/analog-finder.service';

describe('AnalogFinderService', () => {
  const svc = new AnalogFinderService();

  it('finds analogs for central_bank_decision', () => {
    const { analogs } = svc.findAnalogs('signal-1', 'central_bank_decision', 'warning');
    expect(analogs.length).toBeGreaterThan(0);
    expect(analogs[0].episodeTitle).toContain('Fed');
  });

  it('assigns higher similarity for critical/systemic severity', () => {
    const { analogs: critical } = svc.findAnalogs('s1', 'market_stress', 'critical');
    const { analogs: info } = svc.findAnalogs('s2', 'market_stress', 'info');
    const maxCritical = Math.max(...critical.map((a) => a.similarityScore));
    const maxInfo = Math.max(...info.map((a) => a.similarityScore));
    expect(maxCritical).toBeGreaterThan(maxInfo);
  });

  it('returns empty analogs for election_event (no library match)', () => {
    const { analogs } = svc.findAnalogs('s3', 'election_event', 'info');
    expect(analogs).toHaveLength(0);
  });

  it('generates retex insights from analogs', () => {
    const { analogs, insights } = svc.findAnalogs('s4', 'geopolitical_tension', 'critical');
    if (analogs.length > 0) {
      expect(insights.length).toBeGreaterThan(0);
      expect(insights[0].lesson).toContain('épisode');
    }
  });

  it('retex insights reference the analog id', () => {
    const { analogs, insights } = svc.findAnalogs('s5', 'market_stress', 'warning');
    for (const insight of insights) {
      const analog = analogs.find((a) => a.id === insight.analogId);
      expect(analog).toBeDefined();
    }
  });

  it('includes limitation disclaimers in each analog', () => {
    const { analogs } = svc.findAnalogs('s6', 'central_bank_decision', 'warning');
    for (const analog of analogs) {
      expect(analog.limitationsOfComparison.length).toBeGreaterThan(0);
    }
  });
});
