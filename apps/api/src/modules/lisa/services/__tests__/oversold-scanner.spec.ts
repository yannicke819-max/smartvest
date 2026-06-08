/**
 * Tests des helpers PURS du scanner OVERSOLD (filtre drop band, liquidité,
 * tri profondeur, anti-doublon). Aucun mock lourd — logique déterministe.
 */

import {
  computeDropPct,
  isInDropBand,
  passesLiquidity,
  buildOversoldCandidates,
  selectOversoldOpens,
  decideRegimeBlock,
  computeRotationRegime,
  type EodBar,
  type OversoldConfig,
  type RegimeThresholds,
} from '../oversold.helper';

const CFG: OversoldConfig = {
  dropMinPct: -12,
  dropMaxPct: -5,
  holdDays: 10,
  stopCatastrophePct: -15,
  tpPct: null,
  positionNotionalUsd: 1000,
  maxOpenPositions: 200,
  universe: 'russell1000',
  capitalUsd: 150000,
  sizing: {},
};

// Helper : construit 2 barres (J-1, J) avec un drop ciblé et un volume.
function bars(closePrev: number, closeNow: number, volume: number): EodBar[] {
  return [
    { date: '2026-06-02', close: closePrev, volume: volume },
    { date: '2026-06-03', close: closeNow, volume: volume },
  ];
}

describe('computeDropPct', () => {
  it('calcule le drop 1J sur les 2 dernières barres', () => {
    const r = computeDropPct(bars(100, 92, 1_000_000));
    expect(r).not.toBeNull();
    expect(r!.closeJ).toBe(92);
    expect(r!.closeJPrev).toBe(100);
    expect(r!.dropPct).toBeCloseTo(-8, 5);
  });

  it('null si moins de 2 barres', () => {
    expect(computeDropPct([{ date: 'x', close: 10, volume: 1 }])).toBeNull();
    expect(computeDropPct([])).toBeNull();
  });

  it('null si close précédent <= 0 (division impossible)', () => {
    expect(computeDropPct(bars(0, 10, 1))).toBeNull();
  });
});

describe('isInDropBand', () => {
  it('garde un drop dans la bande [-12, -5]', () => {
    expect(isInDropBand(-8, CFG)).toBe(true);
    expect(isInDropBand(-5, CFG)).toBe(true); // borne haute incluse
    expect(isInDropBand(-12, CFG)).toBe(true); // borne basse incluse
  });

  it('exclut le falling-knife (< -12%)', () => {
    expect(isInDropBand(-12.01, CFG)).toBe(false);
    expect(isInDropBand(-25, CFG)).toBe(false);
  });

  it('ignore une chute trop faible (> -5%)', () => {
    expect(isInDropBand(-4.99, CFG)).toBe(false);
    expect(isInDropBand(0, CFG)).toBe(false);
    expect(isInDropBand(3, CFG)).toBe(false); // une hausse
  });
});

describe('passesLiquidity', () => {
  it('rejette les vrais penny stocks (close <= $1, défaut abaissé 08/06)', () => {
    expect(passesLiquidity(1, 10_000_000)).toBe(false);
    expect(passesLiquidity(0.5, 10_000_000)).toBe(false);
  });

  it('accepte un titre EU liquide à bas prix nominal ($3, $16M vol) — ex ETL.PA, NEL.OL', () => {
    // 08/06 — le plancher $5 excluait à tort ces EU TRÈS liquides ; le dollar-volume suffit.
    expect(passesLiquidity(3, 5_400_000)).toBe(true); // $16,2M
  });

  it('rejette le dollar-volume insuffisant (<= $5M)', () => {
    // $10 × 400k = $4M < $5M
    expect(passesLiquidity(10, 400_000)).toBe(false);
  });

  it('accepte prix > $5 ET dollar-volume > $5M', () => {
    // $10 × 600k = $6M
    expect(passesLiquidity(10, 600_000)).toBe(true);
  });
});

describe('buildOversoldCandidates', () => {
  it('filtre par bande + liquidité et trie par profondeur croissante', () => {
    const map = new Map<string, EodBar[]>();
    // AAA: drop -6%, liquide → retenu
    map.set('AAA.US', bars(100, 94, 1_000_000)); // $94 × 1M = $94M OK
    // BBB: drop -10%, liquide → retenu, plus profond que AAA
    map.set('BBB.US', bars(100, 90, 1_000_000));
    // CCC: drop -3% → hors bande (trop faible)
    map.set('CCC.US', bars(100, 97, 1_000_000));
    // DDD: drop -20% → falling-knife exclu
    map.set('DDD.US', bars(100, 80, 1_000_000));
    // EEE: drop -8% mais penny stock ($3) → liquidité KO
    map.set('EEE.US', bars(3.3, 3, 1_000_000));
    // FFF: drop -7% mais dollar-volume $1M < $5M → liquidité KO
    map.set('FFF.US', bars(100, 93, 10_000));

    const out = buildOversoldCandidates(map, CFG);
    expect(out.map((c) => c.symbol)).toEqual(['BBB.US', 'AAA.US']);
    // Le plus profond (BBB -10%) en premier.
    expect(out[0].dropPct).toBeCloseTo(-10, 5);
    expect(out[1].dropPct).toBeCloseTo(-6, 5);
  });

  it('tie-break sur dollar-volume décroissant à drop égal', () => {
    const map = new Map<string, EodBar[]>();
    map.set('LOWVOL.US', bars(100, 92, 100_000)); // -8%, $9.2M
    map.set('HIVOL.US', bars(100, 92, 1_000_000)); // -8%, $92M
    const out = buildOversoldCandidates(map, CFG);
    expect(out.map((c) => c.symbol)).toEqual(['HIVOL.US', 'LOWVOL.US']);
  });

  it('ignore les séries incomplètes (< 2 barres)', () => {
    const map = new Map<string, EodBar[]>();
    map.set('SHORT.US', [{ date: '2026-06-03', close: 92, volume: 1_000_000 }]);
    expect(buildOversoldCandidates(map, CFG)).toEqual([]);
  });
});

describe('selectOversoldOpens (anti-doublon)', () => {
  it('retire les symboles déjà ouverts', () => {
    const map = new Map<string, EodBar[]>();
    map.set('AAA.US', bars(100, 90, 1_000_000));
    map.set('BBB.US', bars(100, 92, 1_000_000));
    const cands = buildOversoldCandidates(map, CFG);
    const open = new Set(['AAA.US']);
    const toOpen = selectOversoldOpens(cands, open);
    expect(toOpen.map((c) => c.symbol)).toEqual(['BBB.US']);
  });

  it('préserve l’ordre de tri', () => {
    const map = new Map<string, EodBar[]>();
    map.set('AAA.US', bars(100, 90, 1_000_000)); // -10%
    map.set('BBB.US', bars(100, 88, 1_000_000)); // -12%
    map.set('CCC.US', bars(100, 94, 1_000_000)); // -6%
    const cands = buildOversoldCandidates(map, CFG);
    const toOpen = selectOversoldOpens(cands, new Set());
    expect(toOpen.map((c) => c.symbol)).toEqual(['BBB.US', 'AAA.US', 'CCC.US']);
  });
});

// US : vixMax 17, ΔVIX 10%, SPY 5d -1%. EU : V2TX 22, ΔV2TX 10%, SX5E 5d -1.5%.
const US_THRESH: RegimeThresholds = { vixMax: 17, vixDeltaMax: 10, idx5dMin: -1 };
const US_LABELS = { vix: 'VIX', idx: 'SPY' };

describe('decideRegimeBlock', () => {
  it('bloque si VIX > vixMax (cas 05/06 : VIX 21.51)', () => {
    const r = decideRegimeBlock({ vix: 21.51, vixChg: 39.7, idx5d: -2.5 }, US_THRESH, US_LABELS);
    expect(r.block).toBe(true);
    expect(r.reason).toBe('VIX 21.51 > 17');
  });

  it('bloque sur un spike ΔVIX > max même si le niveau VIX est OK', () => {
    const r = decideRegimeBlock({ vix: 16, vixChg: 12.5, idx5d: 0.5 }, US_THRESH, US_LABELS);
    expect(r.block).toBe(true);
    expect(r.reason).toBe('ΔVIX 1d 12.5% > +10%');
  });

  it('bloque si index 5j < idx5dMin', () => {
    const r = decideRegimeBlock({ vix: 15, vixChg: 2, idx5d: -1.4 }, US_THRESH, US_LABELS);
    expect(r.block).toBe(true);
    expect(r.reason).toBe('SPY 5d -1.40% < -1%');
  });

  it('passe en régime calme (cas 04/06)', () => {
    const r = decideRegimeBlock({ vix: 15.4, vixChg: 0.5, idx5d: 0.33 }, US_THRESH, US_LABELS);
    expect(r.block).toBe(false);
    expect(r.reason).toBe('pass');
  });

  it('un indicateur null n’enclenche jamais un block (fail-open par indicateur)', () => {
    expect(decideRegimeBlock({ vix: null, vixChg: null, idx5d: null }, US_THRESH, US_LABELS).block).toBe(false);
    // VIX null mais ΔVIX hostile → bloque quand même sur ΔVIX présent
    expect(decideRegimeBlock({ vix: null, vixChg: 20, idx5d: null }, US_THRESH, US_LABELS).block).toBe(true);
    // VIX null + reste sain → pass
    expect(decideRegimeBlock({ vix: null, vixChg: 1, idx5d: 0 }, US_THRESH, US_LABELS).block).toBe(false);
  });

  it('priorité : niveau VIX testé avant ΔVIX avant index', () => {
    // VIX>max ET idx5d<min → la raison citée est le VIX (premier check)
    const r = decideRegimeBlock({ vix: 18, vixChg: 0, idx5d: -5 }, US_THRESH, US_LABELS);
    expect(r.reason).toBe('VIX 18.00 > 17');
  });

  it('formate les labels EU (V2TX / SX5E)', () => {
    const euThresh: RegimeThresholds = { vixMax: 22, vixDeltaMax: 10, idx5dMin: -1.5 };
    const r = decideRegimeBlock({ vix: 24, vixChg: 1, idx5d: 0 }, euThresh, { vix: 'V2TX', idx: 'SX5E' });
    expect(r.reason).toBe('V2TX 24.00 > 22');
  });

  it('bornes strictes : égalité au seuil ne bloque pas', () => {
    // VIX == max : 17 > 17 est faux → pas de block
    expect(decideRegimeBlock({ vix: 17, vixChg: 0, idx5d: 0 }, US_THRESH, US_LABELS).block).toBe(false);
    // idx5d == min : -1 < -1 est faux → pas de block
    expect(decideRegimeBlock({ vix: 15, vixChg: 0, idx5d: -1 }, US_THRESH, US_LABELS).block).toBe(false);
  });
});

describe('computeRotationRegime (rotation offensif/défensif, PR #639)', () => {
  const mkBars = (closes: number[]): EodBar[] => {
    const base = Date.UTC(2026, 0, 1);
    return closes.map((c, i) => ({
      date: new Date(base + i * 86_400_000).toISOString().slice(0, 10),
      close: c,
      volume: 1,
    }));
  };
  const inc = Array.from({ length: 60 }, (_, i) => 100 + i); // 100→159 croissant
  const dec = Array.from({ length: 60 }, (_, i) => 159 - i); // 159→100 décroissant
  const flat = Array.from({ length: 60 }, () => 50);

  it('offensif : numérateur monte vs dénominateur plat → ratio > MM50', () => {
    const r = computeRotationRegime(mkBars(inc), mkBars(flat), 50);
    expect(r.regime).toBe('offensive');
    expect(r.ratio! > r.ma!).toBe(true);
    expect(r.n).toBe(60);
  });

  it('défensif : numérateur baisse vs dénominateur plat → ratio < MM50', () => {
    const r = computeRotationRegime(mkBars(dec), mkBars(flat), 50);
    expect(r.regime).toBe('defensive');
    expect(r.ratio! < r.ma!).toBe(true);
  });

  it('données insuffisantes (< maLen+1 points) → null (fail-open)', () => {
    const r = computeRotationRegime(mkBars(inc.slice(0, 30)), mkBars(flat.slice(0, 30)), 50);
    expect(r.regime).toBeNull();
    expect(r.ma).toBeNull();
  });

  it('aligne par date : dates manquantes dans le dénominateur sont ignorées', () => {
    const off = mkBars(inc); // 60 dates
    const def = mkBars(flat).filter((_, i) => i % 2 === 0); // 1 date sur 2
    const r = computeRotationRegime(off, def, 50);
    expect(r.n).toBe(30); // seules les dates communes comptent
    expect(r.regime).toBeNull(); // 30 < 51 → fail-open
  });

  it('ignore les closes invalides (0 / négatif) dans les deux séries', () => {
    const off = mkBars(inc);
    off[5].close = 0; // ignoré
    const def = mkBars(flat);
    def[10].close = -1; // ignoré
    const r = computeRotationRegime(off, def, 50);
    expect(r.n).toBe(58); // 60 − 2 dates invalides
  });
});
