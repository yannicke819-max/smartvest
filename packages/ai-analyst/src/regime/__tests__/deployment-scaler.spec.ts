/**
 * P2-C — Tests unitaires deployment-scaler.
 */
import {
  computeRegimeAdjustedDeployment,
  RiskOnOffInputs,
} from '../deployment-scaler';

const RISK_ON_INPUTS: RiskOnOffInputs = {
  vix: 16.5,
  us10yYield: 4.4,
  us2yYield: 4.0,
};
const RISK_OFF_INPUTS: RiskOnOffInputs = {
  vix: 28.0,
  us10yYield: 3.8,
  us2yYield: 4.5,
};

describe('computeRegimeAdjustedDeployment', () => {
  it('flags RISK_ON when VIX<20 AND spread>0 → +5pp', () => {
    const v = computeRegimeAdjustedDeployment(RISK_ON_INPUTS, 90);
    expect(v.regime).toBe('RISK_ON');
    expect(v.deltaPct).toBe(5);
    expect(v.adjustedDeploymentPct).toBe(95);
    expect(v.reasons.some((r) => r.includes('vix=16.5'))).toBe(true);
    expect(v.reasons.some((r) => r.includes('spread=40bps>0'))).toBe(true);
  });

  it('flags RISK_OFF when VIX>=20 AND spread<=0 → -20pp', () => {
    const v = computeRegimeAdjustedDeployment(RISK_OFF_INPUTS, 90);
    expect(v.regime).toBe('RISK_OFF');
    expect(v.deltaPct).toBe(-20);
    expect(v.adjustedDeploymentPct).toBe(70);
    expect(v.reasons.some((r) => r.includes('vix=28.0>=20'))).toBe(true);
    expect(v.reasons.some((r) => r.includes('spread=-70bps<=0'))).toBe(true);
  });

  it('returns NEUTRAL when VIX<20 but curve inverted (mixed signals)', () => {
    const v = computeRegimeAdjustedDeployment(
      { vix: 16.5, us10yYield: 3.8, us2yYield: 4.5 },
      90,
    );
    expect(v.regime).toBe('NEUTRAL');
    expect(v.deltaPct).toBe(0);
    expect(v.adjustedDeploymentPct).toBe(90);
  });

  it('returns NEUTRAL when VIX>=20 but curve steepening (mixed signals)', () => {
    const v = computeRegimeAdjustedDeployment(
      { vix: 25.0, us10yYield: 4.4, us2yYield: 4.0 },
      90,
    );
    expect(v.regime).toBe('NEUTRAL');
    expect(v.deltaPct).toBe(0);
    expect(v.adjustedDeploymentPct).toBe(90);
  });

  it('returns NEUTRAL with inputs_incomplete when vix is null', () => {
    const v = computeRegimeAdjustedDeployment(
      { vix: null, us10yYield: 4.4, us2yYield: 4.0 },
      90,
    );
    expect(v.regime).toBe('NEUTRAL');
    expect(v.reasons).toContain('inputs_incomplete');
    expect(v.adjustedDeploymentPct).toBe(90);
  });

  it('returns NEUTRAL when us10y is null', () => {
    const v = computeRegimeAdjustedDeployment(
      { vix: 16, us10yYield: null, us2yYield: 4.0 },
      90,
    );
    expect(v.regime).toBe('NEUTRAL');
    expect(v.reasons).toContain('inputs_incomplete');
    expect(v.deltaPct).toBe(0);
  });

  it('returns NEUTRAL with NaN/Infinity treated as missing', () => {
    const v1 = computeRegimeAdjustedDeployment(
      { vix: NaN, us10yYield: 4.4, us2yYield: 4.0 },
      90,
    );
    expect(v1.regime).toBe('NEUTRAL');
    const v2 = computeRegimeAdjustedDeployment(
      { vix: 16, us10yYield: Infinity, us2yYield: 4.0 },
      90,
    );
    expect(v2.regime).toBe('NEUTRAL');
  });

  it('clamps adjusted deployment within [0, 100]', () => {
    // Baseline 98 + RISK_ON +5 = 103 → clamp 100
    const v1 = computeRegimeAdjustedDeployment(RISK_ON_INPUTS, 98);
    expect(v1.adjustedDeploymentPct).toBe(100);
    expect(v1.deltaPct).toBe(5);

    // Baseline 10 - RISK_OFF -20 = -10 → clamp 0
    const v2 = computeRegimeAdjustedDeployment(RISK_OFF_INPUTS, 10);
    expect(v2.adjustedDeploymentPct).toBe(0);
    expect(v2.deltaPct).toBe(-20);
  });

  it('clamps non-finite baseline to 0', () => {
    const v = computeRegimeAdjustedDeployment(RISK_ON_INPUTS, NaN);
    expect(v.adjustedDeploymentPct).toBeGreaterThanOrEqual(0);
    expect(v.adjustedDeploymentPct).toBeLessThanOrEqual(100);
  });

  it('boundary: VIX exactly 20 is treated as not-calm (RISK_OFF eligible)', () => {
    const v = computeRegimeAdjustedDeployment(
      { vix: 20.0, us10yYield: 3.8, us2yYield: 4.5 },
      90,
    );
    expect(v.regime).toBe('RISK_OFF');
  });

  it('boundary: spread exactly 0 is treated as not-steepening (RISK_OFF eligible)', () => {
    const v = computeRegimeAdjustedDeployment(
      { vix: 25, us10yYield: 4.0, us2yYield: 4.0 },
      90,
    );
    expect(v.regime).toBe('RISK_OFF');
  });

  it('respects different presets: HARVEST baseline 85 + RISK_ON → 90', () => {
    const v = computeRegimeAdjustedDeployment(RISK_ON_INPUTS, 85);
    expect(v.adjustedDeploymentPct).toBe(90);
  });

  it('respects different presets: INVESTMENT baseline 90 - RISK_OFF → 70', () => {
    const v = computeRegimeAdjustedDeployment(RISK_OFF_INPUTS, 90);
    expect(v.adjustedDeploymentPct).toBe(70);
  });
});
