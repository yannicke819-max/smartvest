/**
 * Tests Scanner Momentum Shadow — Phase 4 du refactor scanner.
 * Vérifie agrégation bucket distribution + résolution chosen.
 */

import { summarizeMomentumDecisions, ShadowCandidate } from '../scanner-momentum-shadow.helper';

function cand(symbol: string, opts: Partial<ShadowCandidate> = {}): ShadowCandidate {
  return {
    symbol,
    exchange: 'US',
    close: 100,
    high: 105,
    changePct: 5,
    volume: 1_000_000,
    avgVol50d: 500_000,
    marketCap: 1e9,
    ...opts,
  };
}

describe('Scanner Momentum Shadow', () => {
  it('counts candidates total + with momentum', () => {
    const candidates = [
      cand('AAA', { momentum: { gradientPctPerMin: 0.1, acceleration: 0.05, volumeMomentum: 1.5, verticalityScore: 0.2, risingScore: 0.75, sampleSize: 6 }, bucket: 'sweet_spot_rising' }),
      cand('BBB'), // pas de momentum
      cand('CCC', { momentum: { gradientPctPerMin: -0.15, acceleration: -0.05, volumeMomentum: 0.8, verticalityScore: 0.5, risingScore: 0.25, sampleSize: 6 }, bucket: 'reversing' }),
    ];
    const s = summarizeMomentumDecisions(candidates, null);
    expect(s.candidatesTotal).toBe(3);
    expect(s.candidatesWithMomentum).toBe(2);
  });

  it('bucket distribution agrège correctement', () => {
    const candidates = [
      cand('A', { bucket: 'sweet_spot_rising' }),
      cand('B', { bucket: 'sweet_spot_rising' }),
      cand('C', { bucket: 'peak_parabolic' }),
      cand('D', { bucket: 'stalled' }),
      cand('E'), // unclassified
    ];
    const s = summarizeMomentumDecisions(candidates, null);
    expect(s.bucketDistribution).toEqual({
      sweet_spot_rising: 2,
      peak_parabolic: 1,
      stalled: 1,
      unclassified: 1,
    });
  });

  it('topByRising trié par risingScore desc, max 5', () => {
    const candidates = Array.from({ length: 8 }, (_, i) =>
      cand(`S${i}`, {
        momentum: { gradientPctPerMin: 0.1, acceleration: 0.01, volumeMomentum: 1, verticalityScore: 0.1, risingScore: i / 10, sampleSize: 6 },
        bucket: 'sweet_spot_rising',
      }),
    );
    const s = summarizeMomentumDecisions(candidates, null);
    expect(s.topByRising).toHaveLength(5);
    expect(s.topByRising[0].risingScore).toBe(0.7); // i=7
    expect(s.topByRising[4].risingScore).toBe(0.3); // i=3
  });

  it('resolves chosenSymbol → chosenBucket / chosenRisingScore', () => {
    const candidates = [
      cand('TARGET', {
        changePct: 5.5,
        momentum: { gradientPctPerMin: 0.1, acceleration: 0.02, volumeMomentum: 1.2, verticalityScore: 0.2, risingScore: 0.72, sampleSize: 6 },
        bucket: 'sweet_spot_rising',
      }),
      cand('OTHER'),
    ];
    const s = summarizeMomentumDecisions(candidates, 'TARGET');
    expect(s.chosenSymbol).toBe('TARGET');
    expect(s.chosenBucket).toBe('sweet_spot_rising');
    expect(s.chosenRisingScore).toBe(0.72);
    expect(s.chosenChangePct).toBe(5.5);
  });

  it('chosenSymbol absent du pool → tous nullables', () => {
    const candidates = [cand('AAA', { bucket: 'sweet_spot_rising' })];
    const s = summarizeMomentumDecisions(candidates, 'UNKNOWN');
    expect(s.chosenSymbol).toBe('UNKNOWN');
    expect(s.chosenBucket).toBeNull();
    expect(s.chosenRisingScore).toBeNull();
  });

  it('Phase 2 OFF (zéro momentum) — summary valide, baseline A/B utilisable', () => {
    const candidates = [cand('A'), cand('B'), cand('C')];
    const s = summarizeMomentumDecisions(candidates, null);
    expect(s.candidatesTotal).toBe(3);
    expect(s.candidatesWithMomentum).toBe(0);
    expect(s.bucketDistribution).toEqual({ unclassified: 3 });
    expect(s.topByRising).toEqual([]);
  });

  it('liste vide → summary safe', () => {
    const s = summarizeMomentumDecisions([], null);
    expect(s.candidatesTotal).toBe(0);
    expect(s.candidatesWithMomentum).toBe(0);
    expect(s.bucketDistribution).toEqual({});
    expect(s.topByRising).toEqual([]);
    expect(s.chosenSymbol).toBeNull();
  });
});
