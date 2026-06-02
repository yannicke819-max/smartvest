/**
 * Tests Composite Ranker — Phase 1 du refactor scanner.
 * Vérifie que les sweet-spot candidates rankent au-dessus des paraboliques.
 */

import {
  computeCompositeScore,
  rankByCompositeScore,
  parseCompositeWeights,
  DEFAULT_COMPOSITE_WEIGHTS,
} from '../composite-ranker.helper';

describe('Composite Ranker', () => {
  describe('parseCompositeWeights', () => {
    it('parses valid CSV string', () => {
      const w = parseCompositeWeights('0.5,0.2,0.15,0.1,0.05');
      expect(w.w1_sweetSpot).toBe(0.5);
      expect(w.w2_volume).toBe(0.2);
      expect(w.w3_notAtPeak).toBe(0.15);
      expect(w.w4_mcap).toBe(0.1);
      expect(w.w5_parabolicPenalty).toBe(0.05);
    });

    it('returns DEFAULT on empty string', () => {
      expect(parseCompositeWeights('')).toEqual(DEFAULT_COMPOSITE_WEIGHTS);
      expect(parseCompositeWeights(undefined)).toEqual(DEFAULT_COMPOSITE_WEIGHTS);
    });

    it('returns DEFAULT on invalid input (wrong count)', () => {
      expect(parseCompositeWeights('0.5,0.5')).toEqual(DEFAULT_COMPOSITE_WEIGHTS);
    });

    it('returns DEFAULT on negative value', () => {
      expect(parseCompositeWeights('-0.1,0.2,0.3,0.2,0.4')).toEqual(DEFAULT_COMPOSITE_WEIGHTS);
    });
  });

  describe('computeCompositeScore', () => {
    it('sweet-spot candidate (5%, vol 2x, not at peak) scores HIGHER than parabolic (+30% at peak)', () => {
      const sweetSpot = {
        changePct: 5,
        close: 100,
        high: 105,        // closeToHigh = 0.952 (un peu sous le peak)
        volume: 2_000_000,
        avgVol50d: 1_000_000,
        marketCap: 5_000_000_000, // 5B
      };
      const parabolic = {
        changePct: 30,
        close: 130,
        high: 130,        // closeToHigh = 1 (au peak)
        volume: 5_000_000,
        avgVol50d: 1_000_000,
        marketCap: 5_000_000_000,
      };
      const sweetScore = computeCompositeScore(sweetSpot);
      const parabolicScore = computeCompositeScore(parabolic);
      expect(sweetScore).toBeGreaterThan(parabolicScore);
    });

    it('parabolic 30% gets STRONG penalty (mostly negative score component)', () => {
      const parabolic = {
        changePct: 30,
        close: 130,
        high: 130,
        volume: 2_000_000,
        avgVol50d: 1_000_000,
        marketCap: 5_000_000_000,
      };
      const score = computeCompositeScore(parabolic);
      // Avec penalty pleine (changePct >= 25 → penalty=1), score doit être bas
      // Sans le bonus volume/mcap, ce serait carrément négatif
      expect(score).toBeLessThan(0.3);
    });

    it('higher volume ratio → higher score (all else equal)', () => {
      const base = { changePct: 5, close: 100, high: 105, marketCap: 5_000_000_000, avgVol50d: 1_000_000 };
      const lowVol = computeCompositeScore({ ...base, volume: 500_000 });
      const highVol = computeCompositeScore({ ...base, volume: 2_000_000 });
      expect(highVol).toBeGreaterThan(lowVol);
    });

    it('not-at-peak bonus higher when closeToHigh < 1', () => {
      const base = { changePct: 5, marketCap: 5_000_000_000, volume: 2_000_000, avgVol50d: 1_000_000 };
      const atPeak = computeCompositeScore({ ...base, close: 100, high: 100 }); // closeToHigh = 1
      const notAtPeak = computeCompositeScore({ ...base, close: 95, high: 100 }); // closeToHigh = 0.95
      expect(notAtPeak).toBeGreaterThan(atPeak);
    });

    it('larger mcap → small bonus (preference liquidité)', () => {
      const base = { changePct: 5, close: 100, high: 105, volume: 2_000_000, avgVol50d: 1_000_000 };
      const smallCap = computeCompositeScore({ ...base, marketCap: 50_000_000 }); // 50M
      const largeCap = computeCompositeScore({ ...base, marketCap: 10_000_000_000 }); // 10B
      expect(largeCap).toBeGreaterThan(smallCap);
    });

    it('handles null/missing fields safely (no NaN)', () => {
      const empty = {
        changePct: 0,
        close: 0,
        high: 0,
        volume: 0,
        avgVol50d: 0,
        marketCap: 0,
      };
      const score = computeCompositeScore(empty);
      expect(Number.isFinite(score)).toBe(true);
    });
  });

  describe('rankByCompositeScore', () => {
    it('re-trie : sweet-spot AVANT parabolique', () => {
      const candidates = [
        { symbol: 'PARA.KO', changePct: 30, close: 130, high: 130, volume: 2_000_000, avgVol50d: 1_000_000, marketCap: 5_000_000_000 },
        { symbol: 'SWEET.US', changePct: 5, close: 100, high: 105, volume: 2_000_000, avgVol50d: 1_000_000, marketCap: 5_000_000_000 },
        { symbol: 'PARA2.KO', changePct: 25, close: 125, high: 125, volume: 1_500_000, avgVol50d: 1_000_000, marketCap: 5_000_000_000 },
      ] as Parameters<typeof rankByCompositeScore>[0];
      const ranked = rankByCompositeScore(candidates);
      expect(ranked[0].symbol).toBe('SWEET.US');
      expect(ranked[ranked.length - 1].symbol).toMatch(/PARA/);
    });

    it('ne supprime AUCUN candidat (longueur preservée)', () => {
      const candidates = [
        { symbol: 'A', changePct: 5, close: 100, high: 100, volume: 1000, avgVol50d: 1000, marketCap: 1e9 },
        { symbol: 'B', changePct: 10, close: 100, high: 100, volume: 1000, avgVol50d: 1000, marketCap: 1e9 },
        { symbol: 'C', changePct: 15, close: 100, high: 100, volume: 1000, avgVol50d: 1000, marketCap: 1e9 },
      ] as Parameters<typeof rankByCompositeScore>[0];
      const ranked = rankByCompositeScore(candidates);
      expect(ranked).toHaveLength(3);
    });

    it('preserve les objets originaux (pas de mutation)', () => {
      const original = { symbol: 'X', changePct: 5, close: 100, high: 100, volume: 1000, avgVol50d: 1000, marketCap: 1e9 };
      const ranked = rankByCompositeScore([original as Parameters<typeof rankByCompositeScore>[0][number]]);
      expect(ranked[0]).toBe(original); // même référence
    });

    it('liste vide → vide', () => {
      expect(rankByCompositeScore([])).toEqual([]);
    });
  });
});
