/**
 * P2-A — Tests unitaires du healthcheck inputs régime.
 */
import {
  assertRegimeInputsHealthy,
  RegimeHealthInputs,
} from '../regime-healthcheck.helper';

const HEALTHY: RegimeHealthInputs = {
  vix: 16.5,
  dxy: 102.3,
  us10y: 4.2,
  us2y: 4.8,
  realized1hPct: 1.2,
};

describe('assertRegimeInputsHealthy', () => {
  it('returns healthy when all 5 inputs live + no fallback', () => {
    const v = assertRegimeInputsHealthy(HEALTHY, { fallback: [] });
    expect(v.healthy).toBe(true);
    expect(v.degraded).toEqual([]);
    expect(v.shouldWarn).toBe(false);
  });

  it('does NOT warn when 1 input is null (below threshold)', () => {
    const v = assertRegimeInputsHealthy(
      { ...HEALTHY, vix: null },
      { fallback: [] },
    );
    expect(v.healthy).toBe(false);
    expect(v.degraded).toEqual(['vix=null']);
    expect(v.shouldWarn).toBe(false);
  });

  it('warns when 2 inputs are null', () => {
    const v = assertRegimeInputsHealthy(
      { ...HEALTHY, vix: null, dxy: null },
      { fallback: [] },
    );
    expect(v.shouldWarn).toBe(true);
    expect(v.degraded).toContain('vix=null');
    expect(v.degraded).toContain('dxy=null');
  });

  it('treats NaN/Infinity as null', () => {
    const v = assertRegimeInputsHealthy(
      { ...HEALTHY, vix: NaN, dxy: Infinity },
      { fallback: [] },
    );
    expect(v.shouldWarn).toBe(true);
    expect(v.degraded).toEqual(['vix=null', 'dxy=null']);
  });

  it('warns when 2 inputs are in dataQuality.fallback (stale >24h)', () => {
    const v = assertRegimeInputsHealthy(HEALTHY, {
      fallback: ['vix', 'us10y'],
    });
    expect(v.shouldWarn).toBe(true);
    expect(v.degraded).toEqual(['vix=fallback>24h', 'us10y=fallback>24h']);
  });

  it('mixes null and fallback in the degraded count', () => {
    const v = assertRegimeInputsHealthy(
      { ...HEALTHY, dxy: null },
      { fallback: ['us2y'] },
    );
    expect(v.shouldWarn).toBe(true);
    expect(v.degraded).toContain('dxy=null');
    expect(v.degraded).toContain('us2y=fallback>24h');
  });

  it('null takes precedence over fallback flag for the same key', () => {
    const v = assertRegimeInputsHealthy(
      { ...HEALTHY, vix: null },
      { fallback: ['vix', 'dxy'] },
    );
    // vix counted once (as null), dxy counted (as fallback) → 2 entries
    expect(v.degraded).toEqual(['vix=null', 'dxy=fallback>24h']);
    expect(v.shouldWarn).toBe(true);
  });

  it('realized1hPct null counts but is never flagged via fallback array', () => {
    // realized1hPct n'est pas tracké dans dataQuality (calculé en local).
    // Même si caller met "realized1hPct" dans fallback, on ignore.
    const v = assertRegimeInputsHealthy(
      { ...HEALTHY, realized1hPct: null },
      { fallback: ['realized1hPct'] },
    );
    expect(v.degraded).toEqual(['realized1hPct=null']);
    expect(v.shouldWarn).toBe(false);
  });

  it('warns when 5/5 are degraded (worst case)', () => {
    const v = assertRegimeInputsHealthy(
      { vix: null, dxy: null, us10y: null, us2y: null, realized1hPct: null },
      { fallback: [] },
    );
    expect(v.degraded).toHaveLength(5);
    expect(v.shouldWarn).toBe(true);
  });

  it('ignores irrelevant keys in dataQuality.fallback', () => {
    const v = assertRegimeInputsHealthy(HEALTHY, {
      fallback: ['brent', 'gold', 'btc'],
    });
    expect(v.healthy).toBe(true);
    expect(v.shouldWarn).toBe(false);
  });
});
