import {
  buildVolatilityMap,
  cellVerdict,
  type CartographyCell,
  DEFAULT_VOLATILITY_THRESHOLDS,
  findCellVerdict,
  isCellExcluded,
} from '../volatility-cartography';

function cell(overrides: Partial<CartographyCell> = {}): CartographyCell {
  return {
    sector: 'Technology',
    region: 'US',
    realizedVol5dPct: 20,
    realizedVol20dPct: 22,
    volZScore60d: 0,
    symbolCount: 10,
    ...overrides,
  };
}

describe('volatility-cartography', () => {
  describe('cellVerdict', () => {
    it('returns REGIME_UNKNOWN when sample < min', () => {
      const v = cellVerdict(cell({ symbolCount: 1 }));
      expect(v.decision).toBe('REGIME_UNKNOWN');
      expect(v.lowConfidenceData).toBe(true);
    });

    it('returns MARKET_UNSAFE on stressFlag', () => {
      const v = cellVerdict(cell({ stressFlag: true }));
      expect(v.decision).toBe('MARKET_UNSAFE');
      expect(v.rationale).toContain('StressFlag');
    });

    it('returns MARKET_UNSAFE on absolute vol >= 50%', () => {
      const v = cellVerdict(cell({ realizedVol5dPct: 55 }));
      expect(v.decision).toBe('MARKET_UNSAFE');
      expect(v.rationale).toContain('Vol absolue');
    });

    it('returns MARKET_UNSAFE on z-score >= 2.5', () => {
      const v = cellVerdict(cell({ volZScore60d: 3.0 }));
      expect(v.decision).toBe('MARKET_UNSAFE');
      expect(v.rationale).toContain('panic');
    });

    it('returns REDUCE_SIZE on z-score 1.5..2.5', () => {
      const v = cellVerdict(cell({ volZScore60d: 1.8 }));
      expect(v.decision).toBe('REDUCE_SIZE');
      expect(v.rationale).toContain('stress');
    });

    it('returns CHASE_THE_TOP on z-score <= -1.5 (compression)', () => {
      const v = cellVerdict(cell({ volZScore60d: -2.0 }));
      expect(v.decision).toBe('CHASE_THE_TOP');
      expect(v.rationale).toContain('compression');
    });

    it('returns HOLD in normal zone', () => {
      const v = cellVerdict(cell({ volZScore60d: 0.5 }));
      expect(v.decision).toBe('HOLD');
    });

    it('priority: stressFlag wins over absolute vol', () => {
      // Even with vol < threshold, stressFlag triggers panic
      const v = cellVerdict(cell({ realizedVol5dPct: 15, stressFlag: true }));
      expect(v.decision).toBe('MARKET_UNSAFE');
      expect(v.rationale).toContain('StressFlag');
    });

    it('priority: absolute vol > z-score path when both trigger', () => {
      // Both vol abs and z-score high -> absolute vol message wins (priority order)
      const v = cellVerdict(cell({ realizedVol5dPct: 60, volZScore60d: 3.5 }));
      expect(v.decision).toBe('MARKET_UNSAFE');
      expect(v.rationale).toContain('Vol absolue');
    });
  });

  describe('buildVolatilityMap', () => {
    it('summarizes counts correctly', () => {
      const cells = [
        cell({ sector: 'Tech', region: 'US', volZScore60d: 3.0 }),
        cell({ sector: 'Health', region: 'US', volZScore60d: 1.8 }),
        cell({ sector: 'Energy', region: 'EU', volZScore60d: -2.0 }),
        cell({ sector: 'Cons', region: 'US', volZScore60d: 0 }),
        cell({ sector: 'Util', region: 'EU', symbolCount: 1 }),
      ];
      const map = buildVolatilityMap(cells);
      expect(map.summary.totalCells).toBe(5);
      expect(map.summary.panicCells).toBe(1);
      expect(map.summary.stressedCells).toBe(1);
      expect(map.summary.compressedCells).toBe(1);
      expect(map.summary.healthyCells).toBe(1);
      expect(map.summary.lowDataCells).toBe(1);
    });

    it('excludedCells lists panic cells with sector+region', () => {
      const cells = [
        cell({ sector: 'Tech', region: 'US', volZScore60d: 3.0 }),
        cell({ sector: 'Health', region: 'EU', volZScore60d: 0 }),
      ];
      const map = buildVolatilityMap(cells);
      expect(map.excludedCells).toEqual([{ sector: 'Tech', region: 'US' }]);
    });

    it('empty cells -> empty map', () => {
      const map = buildVolatilityMap([]);
      expect(map.summary.totalCells).toBe(0);
      expect(map.excludedCells).toEqual([]);
    });
  });

  describe('helpers', () => {
    it('findCellVerdict returns the right cell', () => {
      const cells = [
        cell({ sector: 'Tech', region: 'US' }),
        cell({ sector: 'Energy', region: 'EU' }),
      ];
      const map = buildVolatilityMap(cells);
      expect(findCellVerdict(map, 'Energy', 'EU')?.cell.sector).toBe('Energy');
      expect(findCellVerdict(map, 'NonExistent', 'US')).toBeUndefined();
    });

    it('isCellExcluded reflects panic cells', () => {
      const cells = [
        cell({ sector: 'Tech', region: 'US', volZScore60d: 3.0 }),
        cell({ sector: 'Health', region: 'US', volZScore60d: 0 }),
      ];
      const map = buildVolatilityMap(cells);
      expect(isCellExcluded(map, 'Tech', 'US')).toBe(true);
      expect(isCellExcluded(map, 'Health', 'US')).toBe(false);
    });
  });

  describe('threshold overrides', () => {
    it('respects custom panicZScore', () => {
      const v = cellVerdict(
        cell({ volZScore60d: 2.0 }),
        { ...DEFAULT_VOLATILITY_THRESHOLDS, panicZScore: 1.8 },
      );
      expect(v.decision).toBe('MARKET_UNSAFE');
    });

    it('respects custom minSymbolCount', () => {
      const v = cellVerdict(
        cell({ symbolCount: 5 }),
        { ...DEFAULT_VOLATILITY_THRESHOLDS, minSymbolCount: 10 },
      );
      expect(v.decision).toBe('REGIME_UNKNOWN');
    });
  });

  describe('determinism', () => {
    it('same inputs -> same output', () => {
      const c = cell({ volZScore60d: 1.7 });
      expect(cellVerdict(c)).toEqual(cellVerdict(c));
    });
  });
});
