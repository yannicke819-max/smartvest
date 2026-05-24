import {
  parseMicroMomentumGateConfig,
  evaluateMicroGate,
} from '../micro-momentum-gate.helper';

describe('parseMicroMomentumGateConfig', () => {
  it('env vide → enabled false, defaults', () => {
    const c = parseMicroMomentumGateConfig({});
    expect(c.enabled).toBe(false);
    expect(c.minVelocityPctPerS).toBe(0.0001);
    expect(c.minRunLength).toBe(2);
  });
  it('overrides custom', () => {
    const c = parseMicroMomentumGateConfig({
      MICRO_MOMENTUM_GATE_ENABLED: 'true',
      MICRO_MOMENTUM_GATE_MIN_VELOCITY_PCT_S: '0.0005',
      MICRO_MOMENTUM_GATE_MIN_RUN: '5',
    });
    expect(c.enabled).toBe(true);
    expect(c.minVelocityPctPerS).toBe(0.0005);
    expect(c.minRunLength).toBe(5);
  });
  it('valeurs hors range → defaults', () => {
    const c = parseMicroMomentumGateConfig({
      MICRO_MOMENTUM_GATE_MIN_VELOCITY_PCT_S: '0.5', // > 0.01 max
      MICRO_MOMENTUM_GATE_MIN_RUN: '99',             // > 30 max
    });
    expect(c.minVelocityPctPerS).toBe(0.0001);
    expect(c.minRunLength).toBe(2);
  });
});

describe('evaluateMicroGate', () => {
  const enabled = { enabled: true, minVelocityPctPerS: 0.0001, minRunLength: 2 };

  it('gate disabled → pass always', () => {
    const r = evaluateMicroGate({ direction: 'long', velocityPctPerS: -0.001, runLength: 5 });
    expect(r.pass).toBe(true);
    expect(r.reason).toContain('disabled');
  });

  it('velocity null (symbole hors probe) → pass by default', () => {
    const r = evaluateMicroGate({ direction: 'long', velocityPctPerS: null, runLength: null }, enabled);
    expect(r.pass).toBe(true);
    expect(r.reason).toContain('velocity_unavailable');
  });

  it('LONG + velocity positive forte → pass', () => {
    const r = evaluateMicroGate({ direction: 'long', velocityPctPerS: 0.0005, runLength: 5 }, enabled);
    expect(r.pass).toBe(true);
  });

  it('LONG + velocity négative (fade post-pump) → REJECT', () => {
    const r = evaluateMicroGate({ direction: 'long', velocityPctPerS: -0.0002, runLength: 5 }, enabled);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('below_min');
  });

  it('LONG + velocity flat (~0) → REJECT', () => {
    const r = evaluateMicroGate({ direction: 'long', velocityPctPerS: 0.00001, runLength: 5 }, enabled);
    expect(r.pass).toBe(false);
  });

  it('LONG + runLength insuffisant → REJECT', () => {
    const r = evaluateMicroGate({ direction: 'long', velocityPctPerS: 0.001, runLength: 1 }, enabled);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('run_length');
  });

  it('SHORT + velocity négative forte (vrai down momentum) → pass', () => {
    const r = evaluateMicroGate({ direction: 'short', velocityPctPerS: -0.0005, runLength: 5 }, enabled);
    expect(r.pass).toBe(true);
  });

  it('SHORT + velocity positive (mauvais moment shorter) → REJECT', () => {
    const r = evaluateMicroGate({ direction: 'short', velocityPctPerS: 0.0003, runLength: 5 }, enabled);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('above_min');
  });

  it('cas réel SOLUSDT 24/05 : pump déjà fini (velocity flat) à l\'open → aurait REJECT le LONG', () => {
    // À l'open 08:25, le scanner a entré sur ch1m=+4.83% mais le pump était au peak.
    // Si la vélocité 6s avant était ~0 (peak du pump), micro-gate aurait skip.
    const r = evaluateMicroGate({ direction: 'long', velocityPctPerS: 0.00005, runLength: 3 }, enabled);
    expect(r.pass).toBe(false);
  });
});
