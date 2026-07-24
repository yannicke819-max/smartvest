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

describe('computeOversoldNotional — base en % du capital (auto-scale)', () => {
  it('basePctCapital=5% prioritaire sur le notionnel fixe → base = capital × 5%', () => {
    // US $150k × 5% = $7500 base, × deep 2.0 = $15000 (sous plafond 12% = $18000)
    const r = computeOversoldNotional({
      baseNotionalUsd: 1000, // ignoré car % > 0
      dropPct: -9,
      vix: 15,
      capitalUsd: 150_000,
      config: { basePctCapital: 5 },
    });
    expect(r.dynamic).toBe(true);
    expect(r.notionalUsd).toBe(15_000); // 7500 × 2.0
  });

  it('auto-scale : même 5% donne un ticket différent selon le capital', () => {
    const us = computeOversoldNotional({ baseNotionalUsd: 1000, dropPct: -6, vix: 15, capitalUsd: 150_000, config: { basePctCapital: 5 } });
    const eu = computeOversoldNotional({ baseNotionalUsd: 1000, dropPct: -6, vix: 15, capitalUsd: 20_000, config: { basePctCapital: 5 } });
    expect(us.notionalUsd).toBe(7_500); // 150k × 5% × shallow 1.0
    expect(eu.notionalUsd).toBe(1_000); // 20k × 5% × shallow 1.0 (= ancien base fixe préservé)
  });

  it('basePctCapital=0 ou null → retombe sur le notionnel fixe (back-compat)', () => {
    const zero = computeOversoldNotional({ baseNotionalUsd: 1000, dropPct: -6, vix: 15, capitalUsd: 150_000, config: { basePctCapital: 0 } });
    const nul = computeOversoldNotional({ baseNotionalUsd: 1000, dropPct: -6, vix: 15, capitalUsd: 150_000, config: { basePctCapital: null } });
    expect(zero.notionalUsd).toBe(1_000);
    expect(nul.notionalUsd).toBe(1_000);
  });

  it('le plafond 12% s\'applique toujours à la base en %', () => {
    // 10% base × deep 2.0 = 20% du capital > plafond 12% → clamp ceiling
    const r = computeOversoldNotional({ baseNotionalUsd: 1000, dropPct: -9, vix: 15, capitalUsd: 100_000, config: { basePctCapital: 10 } });
    expect(r.clamp).toBe('ceiling');
    expect(r.notionalUsd).toBe(12_000); // 12% de 100k
  });
});

// ── applyExposureBudget (24/07 — audit levier 117%/284%) ──
import { applyExposureBudget } from '../oversold-sizing.helper';

describe('applyExposureBudget', () => {
  const base = { desiredNotionalUsd: 1000, capitalUsd: 20000 };

  it('CAP : skip quand le budget est épuisé (plus jamais de levier ×2.8)', () => {
    const r = applyExposureBudget({ ...base, exposureUsd: 20000, maxExposurePct: 100, targetExposurePct: 85, boostEnabled: true });
    expect(r.skip).toBe(true);
    expect(r.reason).toContain('exposure_cap');
  });

  it('BOOST : book presque vide → position grossie, bornée ×2', () => {
    const r = applyExposureBudget({ ...base, exposureUsd: 2000, maxExposurePct: 100, targetExposurePct: 85, boostEnabled: true }); // util 10% → clamp 25 → 85/25=3.4 → ×2
    expect(r.skip).toBe(false);
    expect(r.boost).toBe(2);
    expect(r.notionalUsd).toBe(2000);
  });

  it('convergence : util proche de la cible → boost ≈ 1', () => {
    const r = applyExposureBudget({ ...base, exposureUsd: 17000, maxExposurePct: 100, targetExposurePct: 85, boostEnabled: true }); // util 85%
    expect(r.boost).toBe(1);
    expect(r.notionalUsd).toBe(1000);
  });

  it('jamais au-dessus du budget libre (le dernier slot est rogné, pas explosé)', () => {
    const r = applyExposureBudget({ ...base, exposureUsd: 19500, maxExposurePct: 100, targetExposurePct: 85, boostEnabled: true }); // libre $500
    expect(r.skip).toBe(false);
    expect(r.notionalUsd).toBe(500);
  });

  it('boost off → taille de base, cap conservé', () => {
    const r = applyExposureBudget({ ...base, exposureUsd: 2000, maxExposurePct: 100, targetExposurePct: 85, boostEnabled: false });
    expect(r.boost).toBe(1);
    expect(r.notionalUsd).toBe(1000);
  });

  it('fail-open : capital inconnu → comportement inchangé', () => {
    const r = applyExposureBudget({ desiredNotionalUsd: 1000, capitalUsd: 0, exposureUsd: 5000 });
    expect(r.skip).toBe(false);
    expect(r.notionalUsd).toBe(1000);
  });
});
