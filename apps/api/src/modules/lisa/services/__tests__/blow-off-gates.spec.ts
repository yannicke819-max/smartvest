import {
  evaluatePathEffLongTf,
  evaluateClimaxRun,
  evaluateVerticalPump,
  evaluateTopTickDrift,
} from '../blow-off-gates.helper';

// Snapshot du candidat OKLO.US au moment de l'ouverture TRADER le 03/06/2026.
// Tous les gates doivent caler sur ces valeurs (test de non-régression).
const OKLO_03_06 = {
  ch1m: 9.84,
  tf5m: 11.79,
  tf30m: 12.10,
  tf1h: 12.08,
  pathQuality: {
    tf5m: { pathEfficiency: 1.0 },
    tf10m: { pathEfficiency: 1.0 },
    tf15m: { pathEfficiency: 0.4468 },
    tf30m: { pathEfficiency: 0.5063 },
    tf1h: { pathEfficiency: 0.2833 },
  },
  candClose: 66.35,
  livePrice: 66.46,
};

describe('evaluatePathEffLongTf — CHOP_LONG_TF gate', () => {
  it('null si threshold null', () => {
    expect(evaluatePathEffLongTf(OKLO_03_06.pathQuality, null)).toBeNull();
    expect(evaluatePathEffLongTf(OKLO_03_06.pathQuality, undefined)).toBeNull();
  });

  it('null si pathQuality manquant', () => {
    expect(evaluatePathEffLongTf(null, 0.3)).toBeNull();
    expect(evaluatePathEffLongTf(undefined, 0.3)).toBeNull();
  });

  it('OKLO.US : tf1h=0.28 < 0.30 → CHOP_LONG_TF [non-régression]', () => {
    const hit = evaluatePathEffLongTf(OKLO_03_06.pathQuality, 0.30);
    expect(hit).not.toBeNull();
    expect((hit as any).tf).toBe('tf1h');
    expect((hit as any).value).toBeCloseTo(0.2833, 3);
  });

  it('passe si tf1h et tf30m au-dessus du seuil', () => {
    const pq = {
      ...OKLO_03_06.pathQuality,
      tf1h: { pathEfficiency: 0.6 },
      tf30m: { pathEfficiency: 0.7 },
    };
    expect(evaluatePathEffLongTf(pq, 0.30)).toBeNull();
  });

  it('detecte tf30m en dessous même si tf1h OK', () => {
    const pq = {
      ...OKLO_03_06.pathQuality,
      tf1h: { pathEfficiency: 0.8 },
      tf30m: { pathEfficiency: 0.20 },
    };
    const hit = evaluatePathEffLongTf(pq, 0.30);
    expect(hit?.tf).toBe('tf30m');
  });

  it('null si tf1h et tf30m manquent (pas de signal)', () => {
    const pq = {
      tf5m: { pathEfficiency: 0.1 },
      tf10m: null,
      tf15m: null,
      tf30m: null,
      tf1h: null,
    };
    expect(evaluatePathEffLongTf(pq, 0.30)).toBeNull();
  });
});

describe('evaluateClimaxRun — plateau-then-burst gate', () => {
  it('OKLO.US : tf5m=11.79, tf30m=12.10 → CLIMAX_RUN [non-régression]', () => {
    const hit = evaluateClimaxRun(OKLO_03_06.tf5m, OKLO_03_06.tf30m);
    expect(hit).not.toBeNull();
    expect((hit as any).gapPct).toBeCloseTo(0.31, 1);
    expect((hit as any).tf5m).toBe(11.79);
  });

  it('null si tf5m < minMove (default 5%)', () => {
    expect(evaluateClimaxRun(3.0, 3.2)).toBeNull();
    expect(evaluateClimaxRun(4.9, 5.0)).toBeNull();
  });

  it('null si gap >= maxPlateauGapPct (default 1.5pt)', () => {
    // tf5m=10%, tf30m=5% → gap 5pt → mouvement progressif, pas plateau
    expect(evaluateClimaxRun(10, 5)).toBeNull();
    expect(evaluateClimaxRun(10, 8)).toBeNull(); // gap 2 > 1.5
  });

  it('détecte plateau standard 6%/6.5% (gap 0.5)', () => {
    const hit = evaluateClimaxRun(6.5, 6.0);
    expect(hit).not.toBeNull();
    expect((hit as any).gapPct).toBeCloseTo(0.5, 2);
  });

  it('null si tf5m ou tf30m manquent', () => {
    expect(evaluateClimaxRun(null, 5)).toBeNull();
    expect(evaluateClimaxRun(5, null)).toBeNull();
    expect(evaluateClimaxRun(undefined, undefined)).toBeNull();
  });

  it('seuils tunables', () => {
    // Avec minMove=3 et maxGap=2, OKLO toujours détecté
    const hit = evaluateClimaxRun(11.79, 12.10, { minTf5mPct: 3, maxPlateauGapPct: 2 });
    expect(hit).not.toBeNull();
    // Avec minMove=15 (très strict), OKLO ne passe plus
    expect(evaluateClimaxRun(11.79, 12.10, { minTf5mPct: 15 })).toBeNull();
  });
});

describe('evaluateVerticalPump — last-minute concentration gate', () => {
  it('OKLO.US : ch1m=9.84% / tf5m=11.79% = 0.834 → VERTICAL_PUMP [non-régression]', () => {
    const hit = evaluateVerticalPump(OKLO_03_06.ch1m, OKLO_03_06.tf5m);
    expect(hit).not.toBeNull();
    expect((hit as any).ratio).toBeCloseTo(0.834, 2);
  });

  it('momentum linéaire passe (ratio ~0.2)', () => {
    // 5min steady : ch1m=2%, tf5m=10% → ratio 0.2
    expect(evaluateVerticalPump(2, 10)).toBeNull();
  });

  it('null si tf5m < minMove (default 5%)', () => {
    // Gentle move : pas de signal vertical pump
    expect(evaluateVerticalPump(3, 4)).toBeNull();
  });

  it('null si ch1m <= 0', () => {
    expect(evaluateVerticalPump(0, 10)).toBeNull();
    expect(evaluateVerticalPump(-1, 10)).toBeNull();
  });

  it('null si ch1m ou tf5m manquent', () => {
    expect(evaluateVerticalPump(null, 10)).toBeNull();
    expect(evaluateVerticalPump(5, null)).toBeNull();
  });

  it('boundary ratio = 0.5 ne déclenche pas (strict >)', () => {
    // ch1m=5, tf5m=10 → ratio exactement 0.5
    expect(evaluateVerticalPump(5, 10)).toBeNull();
  });

  it('NaN → null (pas de crash)', () => {
    expect(evaluateVerticalPump(NaN, 10)).toBeNull();
    expect(evaluateVerticalPump(5, NaN)).toBeNull();
  });

  it('seuils tunables : maxRatio=0.3 plus strict', () => {
    // ch1m=4, tf5m=10 → ratio 0.4 → bloqué avec maxRatio=0.3
    const hit = evaluateVerticalPump(4, 10, { maxRatio: 0.3 });
    expect(hit).not.toBeNull();
  });
});

describe('evaluateTopTickDrift — anti top-tick au fill', () => {
  it('OKLO.US : drift +0.166% < seuil 0.25% → passe (limite)', () => {
    // OKLO réel : drift 0.166% < 0.25% default → passe (les autres gates auront bloqué)
    expect(evaluateTopTickDrift(66.46, 66.35, 0.25)).toBeNull();
  });

  it('OKLO.US : seuil resserré à 0.15% → bloque [non-régression possible config]', () => {
    const hit = evaluateTopTickDrift(66.46, 66.35, 0.15);
    expect(hit).not.toBeNull();
    expect((hit as any).driftPct).toBeCloseTo(0.166, 2);
  });

  it('drift négatif (price baissé) → null', () => {
    expect(evaluateTopTickDrift(65, 66, 0.25)).toBeNull();
  });

  it('drift > seuil → bloque', () => {
    const hit = evaluateTopTickDrift(101, 100, 0.5);
    expect(hit).not.toBeNull();
    expect((hit as any).driftPct).toBeCloseTo(1.0, 3);
  });

  it('null si candClose manquant ou invalide', () => {
    expect(evaluateTopTickDrift(100, null, 0.25)).toBeNull();
    expect(evaluateTopTickDrift(100, 0, 0.25)).toBeNull();
    expect(evaluateTopTickDrift(100, -10, 0.25)).toBeNull();
  });

  it('null si livePrice invalide', () => {
    expect(evaluateTopTickDrift(NaN, 100, 0.25)).toBeNull();
    expect(evaluateTopTickDrift(0, 100, 0.25)).toBeNull();
  });

  it('null si threshold <= 0 ou invalide (désactive le gate)', () => {
    expect(evaluateTopTickDrift(101, 100, 0)).toBeNull();
    expect(evaluateTopTickDrift(101, 100, -1)).toBeNull();
    expect(evaluateTopTickDrift(101, 100, NaN)).toBeNull();
  });
});
