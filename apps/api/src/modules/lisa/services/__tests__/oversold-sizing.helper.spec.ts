import { computeOversoldNotional } from '../oversold-sizing.helper';

describe('computeOversoldNotional — sizing dynamique oversold', () => {
  const CAP = 150_000; // capital large → plafond non contraignant ici

  it('bande -8/-12% (deep) × VIX calme → base × 2.0', () => {
    const r = computeOversoldNotional({ baseNotionalUsd: 1000, dropPct: -9, vix: 15, capitalUsd: CAP });
    expect(r.dynamic).toBe(true);
    expect(r.band).toBe('-8/-12%');
    expect(r.bandMult).toBe(2.0);
    expect(r.vixDamp).toBe(1);
    expect(r.notionalUsd).toBe(2000);
  });

  it('bande -5/-8% (shallow) × VIX calme → base × 1.0', () => {
    const r = computeOversoldNotional({ baseNotionalUsd: 1000, dropPct: -6, vix: 15, capitalUsd: CAP });
    expect(r.band).toBe('-5/-8%');
    expect(r.notionalUsd).toBe(1000);
  });

  it('VIX élevé (20-30) amortit ×0.8', () => {
    const r = computeOversoldNotional({ baseNotionalUsd: 1000, dropPct: -9, vix: 22, capitalUsd: CAP });
    expect(r.vixDamp).toBe(0.8);
    expect(r.notionalUsd).toBe(1600); // 1000 × 2.0 × 0.8
  });

  it('VIX stress (≥30) amortit ×0.5', () => {
    const r = computeOversoldNotional({ baseNotionalUsd: 1000, dropPct: -9, vix: 32, capitalUsd: CAP });
    expect(r.vixDamp).toBe(0.5);
    expect(r.notionalUsd).toBe(1000); // 1000 × 2.0 × 0.5
  });

  it('PLAFOND : clampé à 12% du capital (anti-concentration)', () => {
    // base 2000, deep ×2 = 4000 ; capital 20k → plafond 12% = 2400 → clamp ceiling
    const r = computeOversoldNotional({ baseNotionalUsd: 2000, dropPct: -9, vix: 15, capitalUsd: 20_000 });
    expect(r.clamp).toBe('ceiling');
    expect(r.notionalUsd).toBe(2400);
  });

  it('PLANCHER : jamais sous $500', () => {
    // base 800, shallow ×1 × stress 0.5 = 400 < 500 → floor
    const r = computeOversoldNotional({ baseNotionalUsd: 800, dropPct: -6, vix: 32, capitalUsd: CAP });
    expect(r.clamp).toBe('floor');
    expect(r.notionalUsd).toBe(500);
  });

  it('dropPct null → flat (pas de sizing dynamique)', () => {
    const r = computeOversoldNotional({ baseNotionalUsd: 1000, dropPct: null, vix: 15, capitalUsd: CAP });
    expect(r.dynamic).toBe(false);
    expect(r.notionalUsd).toBe(1000);
  });

  it('désactivable via env → flat', () => {
    const prev = process.env.OVERSOLD_DYNAMIC_SIZING_ENABLED;
    process.env.OVERSOLD_DYNAMIC_SIZING_ENABLED = 'false';
    try {
      const r = computeOversoldNotional({ baseNotionalUsd: 1000, dropPct: -9, vix: 15, capitalUsd: CAP });
      expect(r.dynamic).toBe(false);
      expect(r.notionalUsd).toBe(1000);
    } finally {
      if (prev === undefined) delete process.env.OVERSOLD_DYNAMIC_SIZING_ENABLED;
      else process.env.OVERSOLD_DYNAMIC_SIZING_ENABLED = prev;
    }
  });
});
