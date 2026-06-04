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
  type EodBar,
  type OversoldConfig,
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
  it('rejette les penny stocks (close <= $5)', () => {
    expect(passesLiquidity(5, 10_000_000)).toBe(false);
    expect(passesLiquidity(4.99, 10_000_000)).toBe(false);
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
