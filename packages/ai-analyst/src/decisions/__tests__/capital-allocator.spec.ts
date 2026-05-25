import {
  allocateCapital,
  DEFAULT_ALLOCATION_RULES,
  type StrategyAllocationInput,
} from '../capital-allocator';
import type { StrategyHealth, StrategyState } from '../strategy-lifecycle';

function health(over: Partial<StrategyHealth> = {}): StrategyHealth {
  return {
    sampleSize: 100,
    hitRate: 0.55,
    sharpe: 1.0,
    pnl7dPct: 0.01,
    drawdownPct: 0.03,
    ageDays: 30,
    ...over,
  };
}

function input(
  id: string,
  state: StrategyState,
  base: number,
  over: Partial<StrategyHealth> = {},
): StrategyAllocationInput {
  return { strategyId: id, state, health: health(over), baseAllocationPct: base };
}

describe('allocateCapital', () => {
  describe('terminal states forced to 0', () => {
    it('quarantine -> 0%', () => {
      const r = allocateCapital([input('s1', 'quarantine', 0.20)]);
      expect(r.verdicts[0].finalAllocationPct).toBe(0);
      expect(r.zeroedStrategies).toContain('s1');
    });

    it('retired -> 0%', () => {
      const r = allocateCapital([input('s2', 'retired', 0.20)]);
      expect(r.verdicts[0].finalAllocationPct).toBe(0);
      expect(r.zeroedStrategies).toContain('s2');
    });
  });

  describe('monitoring cap', () => {
    it('caps monitoring to 50% of base', () => {
      const r = allocateCapital([input('s1', 'monitoring', 0.20)]);
      expect(r.verdicts[0].finalAllocationPct).toBeCloseTo(0.10, 3);
      expect(r.verdicts[0].reason).toContain('Monitoring');
    });
  });

  describe('proposed cap', () => {
    it('caps proposed to 10% of base (paper-mostly)', () => {
      const r = allocateCapital([input('s1', 'proposed', 0.20)]);
      expect(r.verdicts[0].finalAllocationPct).toBeCloseTo(0.02, 3);
    });
  });

  describe('active performant boost', () => {
    it('sharpe >= 1.5 ET pnl7d >= 0 -> 1.3x base', () => {
      const r = allocateCapital([input('s1', 'active', 0.20, { sharpe: 2.0, pnl7dPct: 0.02 })]);
      expect(r.verdicts[0].finalAllocationPct).toBeCloseTo(0.26, 3);
      expect(r.verdicts[0].reason).toContain('performant');
    });

    it('boost capped by maxSingleAllocationPct', () => {
      const r = allocateCapital([input('s1', 'active', 0.35, { sharpe: 2.0, pnl7dPct: 0.05 })]);
      // 0.35 * 1.3 = 0.455 -> capped at 0.40
      expect(r.verdicts[0].finalAllocationPct).toBeCloseTo(0.40, 3);
      expect(r.verdicts[0].capped).toBe(true);
    });
  });

  describe('active underperformer haircut', () => {
    it('sharpe < 0.5 -> 0.7x base', () => {
      const r = allocateCapital([input('s1', 'active', 0.20, { sharpe: 0.2 })]);
      expect(r.verdicts[0].finalAllocationPct).toBeCloseTo(0.14, 3);
      expect(r.verdicts[0].reason).toContain('sous-performant');
    });

    it('pnl7d < 0 -> 0.7x even with decent sharpe', () => {
      const r = allocateCapital([input('s1', 'active', 0.20, { sharpe: 1.0, pnl7dPct: -0.01 })]);
      expect(r.verdicts[0].finalAllocationPct).toBeCloseTo(0.14, 3);
    });
  });

  describe('active nominal', () => {
    it('sharpe 1.0 + pnl positif -> 1.0x base', () => {
      const r = allocateCapital([input('s1', 'active', 0.15, { sharpe: 1.0, pnl7dPct: 0.005 })]);
      expect(r.verdicts[0].finalAllocationPct).toBeCloseTo(0.15, 3);
      expect(r.verdicts[0].appliedMultiplier).toBe(1.0);
    });
  });

  describe('min plancher', () => {
    it('active under min plancher -> 0%', () => {
      const r = allocateCapital([input('s1', 'active', 0.03, { sharpe: 1.0 })]);
      // 0.03 * 1.0 = 0.03 < 0.05 plancher
      expect(r.verdicts[0].finalAllocationPct).toBe(0);
      expect(r.zeroedStrategies).toContain('s1');
    });
  });

  describe('rescale when sum > 100%', () => {
    it('rescales proportionally', () => {
      const inputs = [
        input('s1', 'active', 0.40, { sharpe: 2.0, pnl7dPct: 0.05 }), // 0.40*1.3=0.52 cap 0.40
        input('s2', 'active', 0.40, { sharpe: 2.0, pnl7dPct: 0.05 }), // 0.40
        input('s3', 'active', 0.30, { sharpe: 1.0 }), // 0.30
      ];
      const r = allocateCapital(inputs);
      // raw sum = 0.40 + 0.40 + 0.30 = 1.10 > 1.0
      expect(r.rescaled).toBe(true);
      expect(r.totalAllocated).toBeCloseTo(1.0, 3);
    });

    it('does not rescale when sum < 100%', () => {
      const inputs = [
        input('s1', 'active', 0.20, { sharpe: 1.0 }),
        input('s2', 'active', 0.20, { sharpe: 1.0 }),
      ];
      const r = allocateCapital(inputs);
      expect(r.rescaled).toBe(false);
      expect(r.totalAllocated).toBeCloseTo(0.40, 3);
      expect(r.residualCashPct).toBeCloseTo(0.60, 3);
    });
  });

  describe('mixed states scenario', () => {
    it('handles realistic mix correctly', () => {
      const inputs = [
        input('top-gainers', 'active', 0.30, { sharpe: 1.8, pnl7dPct: 0.03 }),
        input('rebound-tp', 'monitoring', 0.20),
        input('harvest', 'active', 0.20, { sharpe: 0.3 }),
        input('experimental', 'proposed', 0.10),
        input('legacy-bull', 'quarantine', 0.20),
      ];
      const r = allocateCapital(inputs);
      // top-gainers: 0.30 * 1.3 = 0.39 (cap 0.40)
      // rebound-tp: 0.20 * 0.5 = 0.10
      // harvest: 0.20 * 0.7 = 0.14
      // experimental: 0.10 * 0.1 = 0.01
      // legacy-bull: 0
      const total = 0.39 + 0.10 + 0.14 + 0.01;
      expect(r.totalAllocated).toBeCloseTo(total, 2);
      expect(r.zeroedStrategies).toContain('legacy-bull');
      expect(r.rescaled).toBe(false);
    });
  });

  describe('determinism', () => {
    it('same inputs -> same output', () => {
      const inputs = [input('s1', 'active', 0.20, { sharpe: 1.2 })];
      expect(allocateCapital(inputs)).toEqual(allocateCapital(inputs));
    });
  });

  it('exports DEFAULT_ALLOCATION_RULES with conservative caps', () => {
    expect(DEFAULT_ALLOCATION_RULES.maxSingleAllocationPct).toBe(0.40);
    expect(DEFAULT_ALLOCATION_RULES.performantMultiplier).toBe(1.3);
    expect(DEFAULT_ALLOCATION_RULES.minActiveAllocationPct).toBe(0.05);
  });
});
