import {
  parseReverseMomentumConfig,
  planOpens,
  computeSlTpForDirection,
  DEFAULT_REVERSE_MOMENTUM,
} from '../reverse-momentum.helper';

describe('parseReverseMomentumConfig', () => {
  it('env vide → long_only default', () => {
    expect(parseReverseMomentumConfig({}).mode).toBe('long_only');
  });
  it('short_only', () => {
    expect(parseReverseMomentumConfig({ REVERSE_MOMENTUM_MODE: 'short_only' }).mode).toBe('short_only');
  });
  it('both', () => {
    expect(parseReverseMomentumConfig({ REVERSE_MOMENTUM_MODE: 'both' }).mode).toBe('both');
  });
  it('valeur invalide → long_only fallback', () => {
    expect(parseReverseMomentumConfig({ REVERSE_MOMENTUM_MODE: 'flip' }).mode).toBe('long_only');
  });
  it('ratio custom valid', () => {
    expect(parseReverseMomentumConfig({
      REVERSE_MOMENTUM_MODE: 'both',
      REVERSE_MOMENTUM_SHORT_RATIO: '0.7',
    }).shortSizeRatio).toBe(0.7);
  });
  it('ratio hors range → 0.5 default', () => {
    expect(parseReverseMomentumConfig({ REVERSE_MOMENTUM_SHORT_RATIO: '2' }).shortSizeRatio).toBe(0.5);
    expect(parseReverseMomentumConfig({ REVERSE_MOMENTUM_SHORT_RATIO: '0' }).shortSizeRatio).toBe(0.5);
  });
});

describe('planOpens', () => {
  it('long_only → [{long, 1.0}]', () => {
    expect(planOpens({ mode: 'long_only', shortSizeRatio: 0.5 })).toEqual([
      { direction: 'long', notionalMultiplier: 1.0 },
    ]);
  });
  it('short_only → [{short, 1.0}]', () => {
    expect(planOpens({ mode: 'short_only', shortSizeRatio: 0.5 })).toEqual([
      { direction: 'short', notionalMultiplier: 1.0 },
    ]);
  });
  it('both → [{long, 0.5}, {short, 0.5}]', () => {
    const r = planOpens({ mode: 'both', shortSizeRatio: 0.5 });
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ direction: 'long', notionalMultiplier: 0.5 });
    expect(r[1]).toEqual({ direction: 'short', notionalMultiplier: 0.5 });
  });
  it('both avec ratio custom 0.7 SHORT → 30% LONG / 70% SHORT', () => {
    const r = planOpens({ mode: 'both', shortSizeRatio: 0.7 });
    expect(r[0].notionalMultiplier).toBeCloseTo(0.30, 5);
    expect(r[1].notionalMultiplier).toBeCloseTo(0.70, 5);
  });
});

describe('computeSlTpForDirection', () => {
  it('LONG : SL en-dessous, TP au-dessus', () => {
    const { stopLoss, takeProfit } = computeSlTpForDirection(100, 1.5, 3.0, 'long');
    expect(stopLoss).toBeCloseTo(98.5, 5);
    expect(takeProfit).toBeCloseTo(103, 5);
  });
  it('SHORT : SL au-dessus, TP en-dessous (inversé)', () => {
    const { stopLoss, takeProfit } = computeSlTpForDirection(100, 1.5, 3.0, 'short');
    expect(stopLoss).toBeCloseTo(101.5, 5);
    expect(takeProfit).toBeCloseTo(97, 5);
  });
  it('cas réel SOLUSDT 24/05 : entry $86.18, sl 1.5%, tp 3%', () => {
    const longSlTp = computeSlTpForDirection(86.18, 1.5, 3.0, 'long');
    expect(longSlTp.stopLoss).toBeCloseTo(84.8873, 2); // SL réel observé 84.76 — proche
    expect(longSlTp.takeProfit).toBeCloseTo(88.7654, 2);
    // SHORT à $86.18 : SL $87.47, TP $83.59 — le SOL retracé à $84.76 aurait été WIN sur SHORT
    const shortSlTp = computeSlTpForDirection(86.18, 1.5, 3.0, 'short');
    expect(shortSlTp.stopLoss).toBeCloseTo(87.4727, 2);
    expect(shortSlTp.takeProfit).toBeCloseTo(83.5946, 2);
  });
});
