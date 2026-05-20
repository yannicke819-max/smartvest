/**
 * PR #367 — Tests gate liquidité (anti-slippage).
 */

import { evaluateLiquidityGate, fxToUsd } from '../liquidity-gate.helper';

describe('fxToUsd', () => {
  it('US sans suffixe → 1', () => {
    expect(fxToUsd('AAPL')).toBe(1);
  });
  it('US avec suffixe → 1', () => {
    expect(fxToUsd('AAPL.US')).toBe(1);
  });
  it('KRW (.KO/.KQ) → ~0.00073', () => {
    expect(fxToUsd('005930.KO')).toBeCloseTo(0.00073, 5);
    expect(fxToUsd('100790.KQ')).toBeCloseTo(0.00073, 5);
  });
  it('LSE en pence → ~0.0127', () => {
    expect(fxToUsd('SCLP.LSE')).toBeCloseTo(0.0127, 4);
    expect(fxToUsd('VOD.L')).toBeCloseTo(0.0127, 4);
  });
  it('CNY (.SHG/.SHE) → 0.139', () => {
    expect(fxToUsd('601678.SHG')).toBe(0.139);
    expect(fxToUsd('300166.SHE')).toBe(0.139);
  });
  it('EUR (.PA) → 1.08', () => {
    expect(fxToUsd('PUB.PA')).toBe(1.08);
  });
  it('devise inconnue → 1 (no-op)', () => {
    expect(fxToUsd('FOO.XYZ')).toBe(1);
  });
});

describe('evaluateLiquidityGate', () => {
  const MIN = 2_000_000; // $2M/jour

  it('US liquide (1M shares × $180) → pass', () => {
    const r = evaluateLiquidityGate('AAPL.US', 180, 1_000_000, MIN);
    expect(r.pass).toBe(true);
    expect(r.dollarVolumeUsd).toBeCloseTo(180_000_000, -3);
  });

  it('KOSDAQ micro-cap illiquide (saigneur 100790.KQ) → block', () => {
    // 100790.KQ : ~50k shares/j × ~5000 KRW × 0.00073 = ~182k USD < 2M
    const r = evaluateLiquidityGate('100790.KQ', 5000, 50_000, MIN);
    expect(r.pass).toBe(false);
    expect(r.dollarVolumeUsd).toBeLessThan(MIN);
    expect(r.reason).toContain('dollar_volume');
  });

  it('KOSPI large liquide → pass', () => {
    // Samsung-like : 10M shares × 70000 KRW × 0.00073 = ~511M USD
    const r = evaluateLiquidityGate('005930.KO', 70000, 10_000_000, MIN);
    expect(r.pass).toBe(true);
  });

  it('penny LSE illiquide (SCLP) → block', () => {
    // 200k shares × 30 pence × 0.0127 = ~76k USD < 2M
    const r = evaluateLiquidityGate('SCLP.LSE', 30, 200_000, MIN);
    expect(r.pass).toBe(false);
  });

  it('avgVol50d=0 → fail-open (pass, données manquantes)', () => {
    const r = evaluateLiquidityGate('X.KQ', 5000, 0, MIN);
    expect(r.pass).toBe(true);
    expect(r.reason).toBe('no_volume_data_fail_open');
  });

  it('close<=0 → fail-open', () => {
    const r = evaluateLiquidityGate('X.KQ', 0, 100000, MIN);
    expect(r.pass).toBe(true);
  });

  it('minUsd=0 → gate désactivé (pass)', () => {
    const r = evaluateLiquidityGate('100790.KQ', 5000, 50_000, 0);
    expect(r.pass).toBe(true);
    expect(r.dollarVolumeUsd).toBeNull();
  });

  it('seuil exact : dollar_volume == minUsd → pass (>=)', () => {
    // construire un cas où dollarVol == 2M : US, close=2, vol=1M → 2M
    const r = evaluateLiquidityGate('X.US', 2, 1_000_000, MIN);
    expect(r.pass).toBe(true);
  });
});
