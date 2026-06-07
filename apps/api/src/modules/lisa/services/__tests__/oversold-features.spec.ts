import {
  computeRsi,
  computeEntryFeatures,
  computeForwardOutcome,
  summarizeEntryNews,
  type EodBar,
} from '../oversold.helper';

function bar(date: string, close: number, volume = 1000): EodBar {
  return { date, close, volume };
}

describe('computeRsi', () => {
  it('renvoie null si pas assez de barres', () => {
    expect(computeRsi([100, 101, 102], 14)).toBeNull();
  });

  it('renvoie 100 si aucune perte sur la fenêtre (hausse pure)', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i); // monotone croissant
    expect(computeRsi(closes, 14)).toBe(100);
  });

  it('renvoie 0 si la fenêtre est plate puis chute (oversold extrême)', () => {
    const closes = [...Array.from({ length: 19 }, () => 100), 92]; // 19 plats + 1 chute
    expect(computeRsi(closes, 14)).toBe(0);
  });
});

describe('computeEntryFeatures', () => {
  // 60 barres plates à 100, drop -8% à l'entrée (idx 59), volume ×2 à l'entrée.
  const bars: EodBar[] = [
    ...Array.from({ length: 59 }, (_, i) => bar(`2026-01-${String(i + 1).padStart(2, '0')}`, 100, 1000)),
    bar('2026-03-01', 92, 2000),
  ];
  const idx = 59;

  it('renvoie null si entryIdx hors bornes', () => {
    expect(computeEntryFeatures(bars, 0)).toBeNull();
    expect(computeEntryFeatures(bars, 999)).toBeNull();
  });

  it('calcule drop1d = -8% sur le drop déclencheur', () => {
    const f = computeEntryFeatures(bars, idx)!;
    expect(f.drop1d).toBeCloseTo(-8, 5);
  });

  it('trend20 ~ 0% sur un historique plat avant le drop (pas falling-knife)', () => {
    const f = computeEntryFeatures(bars, idx)!;
    expect(f.trend20).toBeCloseTo(0, 5);
  });

  it('distMa20 et distMa50 négatives (close sous la moyenne après le drop)', () => {
    const f = computeEntryFeatures(bars, idx)!;
    expect(f.distMa20).toBeCloseTo(-7.63, 1);
    expect(f.distMa50).toBeCloseTo(-7.85, 1);
  });

  it('rsi14 = 0 sur plat puis chute, relVol20 = 2 (volume doublé)', () => {
    const f = computeEntryFeatures(bars, idx)!;
    expect(f.rsi14).toBe(0);
    expect(f.relVol20).toBeCloseTo(2, 5);
  });

  it('vol14 > 0 et drop3d défini', () => {
    const f = computeEntryFeatures(bars, idx)!;
    expect(f.vol14).not.toBeNull();
    expect(f.vol14!).toBeGreaterThan(0);
    expect(f.drop3d).toBeCloseTo(-8, 5);
  });

  it('features de profondeur null si historique trop court', () => {
    const short = bars.slice(50); // 10 barres seulement
    const f = computeEntryFeatures(short, short.length - 1)!;
    expect(f.trend20).toBeNull();
    expect(f.distMa50).toBeNull();
    expect(f.drop1d).toBeCloseTo(-8, 5); // le drop 1j reste calculable
  });
});

describe('summarizeEntryNews', () => {
  const entry = '2026-06-04T20:00:00.000Z';

  it('renvoie 0/null sans article', () => {
    const f = summarizeEntryNews([], entry);
    expect(f.newsCount).toBe(0);
    expect(f.newsMinSentiment).toBeNull();
    expect(f.newsAvgSentiment).toBeNull();
    expect(f.newsAgeHours).toBeNull();
  });

  it('ignore les articles hors fenêtre [entry-72h, entry] (pas de look-ahead)', () => {
    const f = summarizeEntryNews([
      { publishedAt: '2026-06-04T21:00:00.000Z', sentiment: -0.9 }, // APRÈS l'entrée → exclu
      { publishedAt: '2026-05-01T10:00:00.000Z', sentiment: -0.8 }, // > 72h avant → exclu
    ], entry);
    expect(f.newsCount).toBe(0);
  });

  it('agrège count/min/avg/age sur la fenêtre', () => {
    const f = summarizeEntryNews([
      { publishedAt: '2026-06-04T18:00:00.000Z', sentiment: -0.6 }, // 2h avant
      { publishedAt: '2026-06-03T20:00:00.000Z', sentiment: 0.2 }, // 24h avant
    ], entry);
    expect(f.newsCount).toBe(2);
    expect(f.newsMinSentiment).toBeCloseTo(-0.6, 5);
    expect(f.newsAvgSentiment).toBeCloseTo(-0.2, 5);
    expect(f.newsAgeHours).toBeCloseTo(2, 1); // plus récent = 2h avant l'entrée
  });

  it('gère les sentiments null sans casser count', () => {
    const f = summarizeEntryNews([
      { publishedAt: '2026-06-04T18:00:00.000Z', sentiment: null },
      { publishedAt: '2026-06-04T17:00:00.000Z', sentiment: -0.4 },
    ], entry);
    expect(f.newsCount).toBe(2);
    expect(f.newsMinSentiment).toBeCloseTo(-0.4, 5);
  });
});

describe('computeForwardOutcome', () => {
  // 15 barres : entry à idx 2 (close 100), J+10 à idx 12.
  const mk = (closes: number[]): EodBar[] =>
    closes.map((c, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, close: c, volume: 1000 }));

  it('null si entry+horizon hors série (position trop récente)', () => {
    const bars = mk(Array.from({ length: 8 }, () => 100)); // 8 barres
    expect(computeForwardOutcome(bars, 2, 10)).toBeNull(); // 2+10=12 >= 8
  });

  it('rendement positif → outcome 1', () => {
    const closes = Array.from({ length: 15 }, () => 100);
    closes[12] = 110; // J+10 (idx 2+10) à +10%
    const f = computeForwardOutcome(mk(closes), 2, 10)!;
    expect(f.fwdReturn).toBeCloseTo(10, 5);
    expect(f.fwdOutcome).toBe(1);
  });

  it('rendement négatif → outcome 0', () => {
    const closes = Array.from({ length: 15 }, () => 100);
    closes[12] = 92; // J+10 à -8%
    const f = computeForwardOutcome(mk(closes), 2, 10)!;
    expect(f.fwdReturn).toBeCloseTo(-8, 5);
    expect(f.fwdOutcome).toBe(0);
  });
});
