/**
 * P4-B — Tests routing sources par mode opératoire.
 */
import {
  getProposalSources,
  isHarvestMode,
  shouldRunNewsAggregator,
  HARVEST_PROPOSAL_SOURCES,
  INVESTMENT_PROPOSAL_SOURCES,
} from '../proposal-source-routing';

describe('isHarvestMode', () => {
  it('matches DB convention DAILY_HARVEST', () => {
    expect(isHarvestMode('DAILY_HARVEST')).toBe(true);
  });

  it('matches lowercase harvest from spec', () => {
    expect(isHarvestMode('harvest')).toBe(true);
  });

  it('matches mixed case', () => {
    expect(isHarvestMode('Daily_Harvest')).toBe(true);
    expect(isHarvestMode('Harvest')).toBe(true);
  });

  it('returns false for NONE', () => {
    expect(isHarvestMode('NONE')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isHarvestMode(null)).toBe(false);
    expect(isHarvestMode(undefined)).toBe(false);
  });

  it('returns false for arbitrary string', () => {
    expect(isHarvestMode('investment')).toBe(false);
    expect(isHarvestMode('')).toBe(false);
  });

  it('returns false for non-string types', () => {
    expect(isHarvestMode(42 as unknown as string)).toBe(false);
  });
});

describe('getProposalSources', () => {
  it('returns harvest sources (rebound + mechanical) for DAILY_HARVEST', () => {
    expect(getProposalSources('DAILY_HARVEST')).toEqual([
      'rebound_tp_scanner',
      'mechanical_stops',
    ]);
  });

  it('returns harvest sources for lowercase harvest', () => {
    expect(getProposalSources('harvest')).toEqual([...HARVEST_PROPOSAL_SOURCES]);
  });

  it('returns full investment sources for NONE', () => {
    const sources = getProposalSources('NONE');
    expect(sources).toEqual([...INVESTMENT_PROPOSAL_SOURCES]);
    expect(sources).toContain('rebound_tp_scanner');
    expect(sources).toContain('momentum_breakout');
    expect(sources).toContain('narrative_stocktwits');
    expect(sources).toContain('sentiment_macro');
    expect(sources).toContain('mechanical_stops');
  });

  it('returns full investment sources for null', () => {
    expect(getProposalSources(null)).toEqual([...INVESTMENT_PROPOSAL_SOURCES]);
  });

  it('returns full investment sources for undefined', () => {
    expect(getProposalSources(undefined)).toEqual([...INVESTMENT_PROPOSAL_SOURCES]);
  });

  it('returns NEW array each call (no shared mutable reference)', () => {
    const a = getProposalSources('harvest');
    const b = getProposalSources('harvest');
    a.push('hacked' as never);
    expect(b).not.toContain('hacked');
  });

  it('harvest sources is strict subset of investment sources', () => {
    const harvest = getProposalSources('harvest');
    const investment = getProposalSources(null);
    for (const src of harvest) {
      expect(investment).toContain(src);
    }
  });
});

describe('shouldRunNewsAggregator', () => {
  it('returns false in harvest mode', () => {
    expect(shouldRunNewsAggregator('DAILY_HARVEST')).toBe(false);
    expect(shouldRunNewsAggregator('harvest')).toBe(false);
  });

  it('returns true in investment / NONE / null mode', () => {
    expect(shouldRunNewsAggregator('NONE')).toBe(true);
    expect(shouldRunNewsAggregator(null)).toBe(true);
    expect(shouldRunNewsAggregator(undefined)).toBe(true);
    expect(shouldRunNewsAggregator('investment')).toBe(true);
  });
});
