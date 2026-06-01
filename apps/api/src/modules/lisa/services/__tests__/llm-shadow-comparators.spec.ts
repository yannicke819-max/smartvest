import { dailyBriefComparator, jaccardSimilarity, parseLooseJson, postmortemComparator } from '../llm-shadow-comparators';

describe('llm-shadow-comparators', () => {
  describe('jaccardSimilarity', () => {
    it('returns 1 for 2 empty sets', () => {
      expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
    });

    it('returns 0 when one set is empty', () => {
      expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0);
    });

    it('returns intersection/union for overlapping sets', () => {
      // A={a,b,c}, B={b,c,d} → intersection={b,c}, union={a,b,c,d} → 2/4 = 0.5
      expect(jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(0.5);
    });

    it('returns 1 for identical sets', () => {
      expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    });
  });

  describe('parseLooseJson', () => {
    it('parses plain JSON', () => {
      expect(parseLooseJson('{"a": 1}')).toEqual({ a: 1 });
    });

    it('parses JSON in ```json fences', () => {
      expect(parseLooseJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    });

    it('extracts first { ... } block', () => {
      expect(parseLooseJson('Some prefix text {"a": 1} suffix')).toEqual({ a: 1 });
    });

    it('returns null for unparseable', () => {
      expect(parseLooseJson('not json at all')).toBeNull();
    });
  });

  describe('dailyBriefComparator', () => {
    const briefA = `{
      "date": "2026-06-01",
      "macro_events": [
        {"time_utc": "06:00", "event": "DE Retail Sales", "impact": "medium"},
        {"time_utc": "09:00", "event": "EU Unemployment Rate", "impact": "high"},
        {"time_utc": "14:00", "event": "US ISM Manufacturing PMI", "impact": "medium"}
      ]
    }`;

    const briefBSimilar = `\`\`\`json
{
  "date": "2026-06-01",
  "macro_events": [
    {"time_utc":"06:00","event":"DE Retail Sales","impact":"medium"},
    {"time_utc":"09:00","event":"EU Unemployment Rate","impact":"high"},
    {"time_utc":"14:00","event":"US ISM Manufacturing PMI New Orders","impact":"medium"}
  ]
}
\`\`\``;

    const briefBDifferent = `{
      "date": "2026-06-01",
      "macro_events": [
        {"time_utc": "10:00", "event": "JP GDP Quarterly", "impact": "high"},
        {"time_utc": "12:00", "event": "CN Trade Balance", "impact": "medium"}
      ]
    }`;

    it('returns true for substantially identical briefs (different formatting)', () => {
      expect(dailyBriefComparator(briefA, briefBSimilar)).toBe(true);
    });

    it('returns false for fully different events', () => {
      expect(dailyBriefComparator(briefA, briefBDifferent)).toBe(false);
    });

    it('returns false on unparseable input', () => {
      expect(dailyBriefComparator(briefA, 'not json')).toBe(false);
    });
  });

  describe('postmortemComparator', () => {
    const postA = `{
      "lessons": [
        {"macro_condition": "TRAIL_STOP_CRYPTO", "lesson_text": "..."},
        {"macro_condition": "MFE_TRIGGER", "lesson_text": "..."},
        {"macro_condition": "KOSDAQ_SMALL", "lesson_text": "..."}
      ]
    }`;

    const postBSimilar = `{
      "lessons": [
        {"macro_condition": "trail_stop_crypto", "lesson_text": "different text"},
        {"macro_condition": "mfe_trigger", "lesson_text": "yet other text"},
        {"macro_condition": "kosdaq_small", "lesson_text": "..."}
      ]
    }`;

    const postBDifferent = `{
      "lessons": [
        {"macro_condition": "US_HOURLY_BLACKLIST", "lesson_text": "..."},
        {"macro_condition": "EU_NEWS_SHOCK", "lesson_text": "..."}
      ]
    }`;

    it('returns true for same macro_conditions (case-insensitive)', () => {
      expect(postmortemComparator(postA, postBSimilar)).toBe(true);
    });

    it('returns false for different macro_conditions', () => {
      expect(postmortemComparator(postA, postBDifferent)).toBe(false);
    });

    it('fallback tokens : returns false if no JSON parse', () => {
      // Both unparseable → fallback tokens; long different texts → < 0.4 Jaccard
      const textA = 'The first text discusses momentum trading strategies on Asian markets';
      const textB = 'A completely different document about crypto futures arbitrage opportunities';
      expect(postmortemComparator(textA, textB)).toBe(false);
    });
  });
});
