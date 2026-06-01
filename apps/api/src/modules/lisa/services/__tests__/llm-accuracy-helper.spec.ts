import { brierScore, pearsonCorrelation, directionalAccuracy, parseRiskVerdictScore } from '../llm-accuracy.helper';

describe('llm-accuracy.helper', () => {
  describe('brierScore', () => {
    it('returns 0 for perfect predictions', () => {
      expect(brierScore([1, 0, 1, 0], [1, 0, 1, 0])).toBe(0);
    });

    it('returns 1 for worst predictions', () => {
      expect(brierScore([1, 0], [0, 1])).toBe(1);
    });

    it('returns 0.25 for baseline (always 0.5)', () => {
      expect(brierScore([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0])).toBe(0.25);
    });

    it('returns null for empty', () => {
      expect(brierScore([], [])).toBeNull();
    });
  });

  describe('pearsonCorrelation', () => {
    it('returns 1 for perfect positive linear', () => {
      const r = pearsonCorrelation([1, 2, 3, 4], [10, 20, 30, 40]);
      expect(r).toBeCloseTo(1, 5);
    });

    it('returns -1 for perfect negative linear', () => {
      const r = pearsonCorrelation([1, 2, 3, 4], [40, 30, 20, 10]);
      expect(r).toBeCloseTo(-1, 5);
    });

    it('returns null for constant series (variance=0)', () => {
      expect(pearsonCorrelation([1, 1, 1], [2, 3, 4])).toBeNull();
    });

    it('returns null for too few samples', () => {
      expect(pearsonCorrelation([1], [2])).toBeNull();
    });
  });

  describe('directionalAccuracy', () => {
    it('returns 1 when all directional matches', () => {
      // 0.7 + 0.5%, 0.3 + (-1%), 0.8 + 2% → 3/3 matches (bullish ↔ positive)
      // BUT directionalAccuracy considers score>0.5 as bullish strictly, so 0.5 = bearish
      const r = directionalAccuracy([0.7, 0.3, 0.8], [0.5, -1, 2]);
      expect(r).toBe(1);
    });

    it('returns 0 when all flipped', () => {
      expect(directionalAccuracy([0.8, 0.2], [-1, 1])).toBe(0);
    });

    it('returns 0.5 for mixed', () => {
      expect(directionalAccuracy([0.8, 0.2, 0.8, 0.2], [1, -1, -1, 1])).toBe(0.5);
    });
  });

  describe('parseRiskVerdictScore', () => {
    it('parses JSON brut score', () => {
      expect(parseRiskVerdictScore('{"score": 0.5, "rationale": "..."}')).toBe(0.5);
    });

    it('parses JSON in ```json fences', () => {
      expect(parseRiskVerdictScore('```json\n{"score": 0.7}\n```')).toBe(0.7);
    });

    it('parses score from text "score: 0.3"', () => {
      expect(parseRiskVerdictScore('Le score est score: 0.3 mais rationale...')).toBe(0.3);
    });

    it('returns null for unparseable', () => {
      expect(parseRiskVerdictScore('no score here')).toBeNull();
    });

    it('returns null for out-of-range score', () => {
      expect(parseRiskVerdictScore('{"score": 1.5}')).toBeNull();
    });

    it('returns null for null/undefined', () => {
      expect(parseRiskVerdictScore(null)).toBeNull();
      expect(parseRiskVerdictScore(undefined)).toBeNull();
    });
  });
});
