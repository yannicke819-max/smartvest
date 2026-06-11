import {
  OVERSOLD_FEATURE_NAMES,
  extractFeatureRow,
  buildOversoldTrainingSet,
} from '../oversold-probability.helper';

describe('oversold-probability helper — Phase 3', () => {
  it('extractFeatureRow mappe les 16 features, non-fini → 0', () => {
    const row = extractFeatureRow({ vix: 19.8, rsi14: 65, drop1d: -6.2, newsAvgSentiment: null, bogus: 99 });
    expect(Object.keys(row).sort()).toEqual([...OVERSOLD_FEATURE_NAMES].sort());
    expect(row.vix).toBe(19.8);
    expect(row.rsi14).toBe(65);
    expect(row.drop1d).toBe(-6.2);
    expect(row.newsAvgSentiment).toBe(0); // null → 0
    expect(row.vol14).toBe(0); // absent → 0
    expect((row as Record<string, number>).bogus).toBeUndefined(); // hors liste ignoré
  });

  it('extractFeatureRow gère features null', () => {
    const row = extractFeatureRow(null);
    expect(Object.keys(row)).toHaveLength(OVERSOLD_FEATURE_NAMES.length);
    expect(Object.values(row).every((v) => v === 0)).toBe(true);
  });

  it('buildOversoldTrainingSet ne garde que les trades labellisés (fwdOutcome non null)', () => {
    const ts = buildOversoldTrainingSet([
      { features: { vix: 20, drop1d: -6 }, fwdOutcome: 1 },
      { features: { vix: 22, drop1d: -9 }, fwdOutcome: 0 },
      { features: { vix: 18, drop1d: -4 }, fwdOutcome: null }, // pas encore labellisé → exclu
    ]);
    expect(ts.n).toBe(2);
    expect(ts.y).toEqual([1, 0]);
    expect(ts.wins).toBe(1);
    expect(ts.names).toEqual([...OVERSOLD_FEATURE_NAMES]);
    expect(ts.X).toHaveLength(2);
  });

  it('y = 1 uniquement si fwd_outcome_10d === 1', () => {
    const ts = buildOversoldTrainingSet([
      { features: {}, fwdOutcome: 1 },
      { features: {}, fwdOutcome: 0 },
      { features: {}, fwdOutcome: -1 }, // pas == 1 → loss
    ]);
    expect(ts.y).toEqual([1, 0, 0]);
  });
});
