import {
  computeRsi,
  computeEntryFeatures,
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
