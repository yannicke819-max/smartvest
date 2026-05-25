import {
  DEFAULT_LIFECYCLE_RULES,
  evaluateLifecycle,
  type StrategyHealth,
} from '../strategy-lifecycle';

function health(overrides: Partial<StrategyHealth> = {}): StrategyHealth {
  return {
    sampleSize: 100,
    hitRate: 0.55,
    sharpe: 1.2,
    pnl7dPct: 0.01,
    drawdownPct: 0.03,
    ageDays: 30,
    ...overrides,
  };
}

describe('strategy-lifecycle.evaluateLifecycle', () => {
  describe('critical violation', () => {
    it('forces quarantine even from active', () => {
      const r = evaluateLifecycle('active', health({ criticalViolation: true }));
      expect(r.nextState).toBe('quarantine');
      expect(r.changed).toBe(true);
      expect(r.suggestedVerdict).toBe('QUARANTINE');
      expect(r.reason).toContain('critique');
    });

    it('forces quarantine even from proposed', () => {
      const r = evaluateLifecycle('proposed', health({ sampleSize: 5, criticalViolation: true }));
      expect(r.nextState).toBe('quarantine');
    });
  });

  describe('retired (inviable)', () => {
    it('retires when hitRate < 30% on sample >= 50', () => {
      const r = evaluateLifecycle('active', health({ sampleSize: 60, hitRate: 0.25 }));
      expect(r.nextState).toBe('retired');
      expect(r.suggestedVerdict).toBe('QUARANTINE');
      expect(r.reason).toContain('25%');
    });

    it('does NOT retire when sample < 50', () => {
      const r = evaluateLifecycle('active', health({ sampleSize: 40, hitRate: 0.20 }));
      expect(r.nextState).not.toBe('retired');
    });
  });

  describe('quarantine on drawdown / pnl', () => {
    it('quarantines on drawdown >= 15%', () => {
      const r = evaluateLifecycle('active', health({ drawdownPct: 0.20 }));
      expect(r.nextState).toBe('quarantine');
      expect(r.reason).toContain('Drawdown');
    });

    it('quarantines on pnl7d <= -5%', () => {
      const r = evaluateLifecycle('active', health({ pnl7dPct: -0.07 }));
      expect(r.nextState).toBe('quarantine');
      expect(r.reason).toContain('PnL 7j');
    });
  });

  describe('monitoring on light pnl drop', () => {
    it('moves to monitoring on pnl7d -3%', () => {
      const r = evaluateLifecycle('active', health({ pnl7dPct: -0.03 }));
      expect(r.nextState).toBe('monitoring');
      expect(r.suggestedVerdict).toBe('REDUCE_SIZE');
    });

    it('does not flip to monitoring on tiny dip -1%', () => {
      const r = evaluateLifecycle('active', health({ pnl7dPct: -0.01 }));
      expect(r.nextState).toBe('active');
    });
  });

  describe('rehabilitation monitoring -> active', () => {
    it('rehabilitates when pnl7d >= 0 and cooldown 7d reached', () => {
      const r = evaluateLifecycle('monitoring', health({ pnl7dPct: 0.005, ageDays: 10 }));
      expect(r.nextState).toBe('active');
      expect(r.reason).toContain('réhabilitation');
    });

    it('stays monitoring if cooldown not reached', () => {
      const r = evaluateLifecycle('monitoring', health({ pnl7dPct: 0.005, ageDays: 3 }));
      expect(r.nextState).toBe('monitoring');
      expect(r.changed).toBe(false);
    });

    it('stays monitoring if pnl still negative', () => {
      const r = evaluateLifecycle('monitoring', health({ pnl7dPct: -0.005, ageDays: 30 }));
      expect(r.nextState).toBe('monitoring');
    });
  });

  describe('activation proposed -> active', () => {
    it('activates with sample >= 30 and hitRate >= 45%', () => {
      const r = evaluateLifecycle('proposed', health({ sampleSize: 35, hitRate: 0.50 }));
      expect(r.nextState).toBe('active');
      expect(r.changed).toBe(true);
      expect(r.suggestedVerdict).toBe('HOLD');
    });

    it('stays proposed on small sample', () => {
      const r = evaluateLifecycle('proposed', health({ sampleSize: 10, hitRate: 0.60 }));
      expect(r.nextState).toBe('proposed');
      expect(r.suggestedVerdict).toBe('PAPER_ONLY');
    });

    it('stays proposed on low hitRate', () => {
      const r = evaluateLifecycle('proposed', health({ sampleSize: 35, hitRate: 0.35 }));
      expect(r.nextState).toBe('proposed');
    });
  });

  describe('terminal states (no auto-transition)', () => {
    it('quarantine stays quarantine even with healthy metrics', () => {
      const r = evaluateLifecycle('quarantine', health({ pnl7dPct: 0.10, drawdownPct: 0.01, hitRate: 0.70 }));
      expect(r.nextState).toBe('quarantine');
      expect(r.changed).toBe(false);
      expect(r.reason).toContain('manuelle');
    });

    it('retired stays retired even with healthy metrics', () => {
      const r = evaluateLifecycle('retired', health({ pnl7dPct: 0.10, hitRate: 0.80 }));
      expect(r.nextState).toBe('retired');
      expect(r.changed).toBe(false);
    });
  });

  describe('priorité des règles', () => {
    it('critical wins over good metrics', () => {
      const r = evaluateLifecycle('active', health({ pnl7dPct: 0.10, criticalViolation: true }));
      expect(r.nextState).toBe('quarantine');
    });

    it('retired wins over drawdown (more severe)', () => {
      const r = evaluateLifecycle('active', health({ sampleSize: 100, hitRate: 0.20, drawdownPct: 0.20 }));
      expect(r.nextState).toBe('retired');
    });
  });

  describe('determinisme', () => {
    it('same inputs -> same output', () => {
      const h = health({ pnl7dPct: -0.04 });
      expect(evaluateLifecycle('active', h)).toEqual(evaluateLifecycle('active', h));
    });
  });

  it('exports DEFAULT_LIFECYCLE_RULES with conservative thresholds', () => {
    expect(DEFAULT_LIFECYCLE_RULES.minSampleForActivation).toBe(30);
    expect(DEFAULT_LIFECYCLE_RULES.quarantineDrawdownThreshold).toBe(0.15);
    expect(DEFAULT_LIFECYCLE_RULES.retiredHitRateThreshold).toBe(0.30);
  });
});
