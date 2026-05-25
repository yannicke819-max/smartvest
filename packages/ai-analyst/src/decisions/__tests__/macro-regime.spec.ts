import {
  DEFAULT_MACRO_REGIME_THRESHOLDS,
  detectMacroRegime,
  type MacroRegimeInputs,
} from '../macro-regime';

describe('detectMacroRegime', () => {
  describe('empty / degenerate', () => {
    it('returns UNKNOWN when no features provided', () => {
      const r = detectMacroRegime({});
      expect(r.regime).toBe('UNKNOWN');
      expect(r.confidence).toBe(0);
      expect(r.suggestedVerdict).toBe('REGIME_UNKNOWN');
    });

    it('UNKNOWN when only null features', () => {
      const r = detectMacroRegime({ vix: null, hyOasBps: null });
      expect(r.regime).toBe('UNKNOWN');
    });

    it('UNKNOWN when features are present but all in neutral zone', () => {
      // VIX 20 is between vixRiskOnMax (18) and vixRiskOffMin (22) -> no contrib
      // Term spread 50bps is between 0 and 100 -> no contrib
      const r = detectMacroRegime({ vix: 20, termSpreadBps: 50 });
      expect(r.regime).toBe('UNKNOWN');
    });
  });

  describe('RISK_ON', () => {
    it('VIX low + term spread steep + HY tight -> RISK_ON', () => {
      const r = detectMacroRegime({
        vix: 14,
        termSpreadBps: 120,
        hyOasBps: 350,
      });
      expect(r.regime).toBe('RISK_ON');
      expect(r.suggestedVerdict).toBe('HOLD');
      expect(r.confidence).toBeGreaterThan(0.5);
    });

    it('rationale mentions regime and confidence', () => {
      const r = detectMacroRegime({ vix: 14, hyOasBps: 350 });
      expect(r.rationale).toContain('RISK_ON');
      expect(r.rationale).toMatch(/\d+%/);
    });
  });

  describe('EUPHORIA', () => {
    it('VIX < 12 + HY ultra-tight -> EUPHORIA', () => {
      const r = detectMacroRegime({ vix: 10, hyOasBps: 250 });
      expect(r.regime).toBe('EUPHORIA');
      expect(r.suggestedVerdict).toBe('REDUCE_SIZE');
    });

    it('EUPHORIA confidence high when both VIX and HY align', () => {
      const r = detectMacroRegime({ vix: 9, hyOasBps: 220 });
      expect(r.regime).toBe('EUPHORIA');
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe('RISK_OFF', () => {
    it('VIX 24 + term inverted + HY wide -> RISK_OFF', () => {
      const r = detectMacroRegime({
        vix: 24,
        termSpreadBps: -20,
        hyOasBps: 550,
      });
      expect(r.regime).toBe('RISK_OFF');
      expect(r.suggestedVerdict).toBe('REDUCE_SIZE');
    });

    it('DXY 5d +3% pushes toward RISK_OFF', () => {
      const r = detectMacroRegime({ vix: 24, dxyChange5dPct: 3.0 });
      expect(r.regime).toBe('RISK_OFF');
    });
  });

  describe('PANIC', () => {
    it('VIX 40 + HY blowout -> PANIC', () => {
      const r = detectMacroRegime({ vix: 40, hyOasBps: 750 });
      expect(r.regime).toBe('PANIC');
      expect(r.suggestedVerdict).toBe('MARKET_UNSAFE');
      expect(r.confidence).toBeGreaterThan(0.5);
    });

    it('PANIC dominates when both VIX and HY blow out together', () => {
      const r = detectMacroRegime({ vix: 38, hyOasBps: 720 });
      expect(r.regime).toBe('PANIC');
    });
  });

  describe('data quality', () => {
    it('haircut confidence by 30% when dataQualityDegraded=true', () => {
      const clean = detectMacroRegime({ vix: 14, hyOasBps: 300 });
      const degraded = detectMacroRegime({ vix: 14, hyOasBps: 300, dataQualityDegraded: true });
      expect(degraded.regime).toBe(clean.regime);
      expect(degraded.confidence).toBeCloseTo(clean.confidence * 0.7, 2);
    });
  });

  describe('explainability', () => {
    it('contributingFeatures lists every feature that scored', () => {
      const r = detectMacroRegime({ vix: 14, hyOasBps: 300, termSpreadBps: 120 });
      const features = r.contributingFeatures.map((c) => c.feature);
      expect(features).toContain('vix');
      expect(features).toContain('hyOasBps');
      expect(features).toContain('termSpreadBps');
    });

    it('scores show per-regime breakdown', () => {
      const r = detectMacroRegime({ vix: 14, hyOasBps: 300 });
      expect(r.scores.RISK_ON).toBeGreaterThan(0);
      expect(r.scores.PANIC).toBe(0);
    });
  });

  describe('threshold overrides', () => {
    it('respects custom thresholds', () => {
      // With stricter EUPHORIA threshold, VIX=11 might not trigger
      const strict = detectMacroRegime(
        { vix: 11, hyOasBps: 400 },
        { ...DEFAULT_MACRO_REGIME_THRESHOLDS, vixEuphoriaMax: 10 },
      );
      // vix 11 >= 10 (strict euphoria max) AND < 18 (riskOnMax) -> RISK_ON only
      expect(strict.regime).toBe('RISK_ON');
    });
  });

  describe('determinism', () => {
    it('same inputs -> same output', () => {
      const inputs: MacroRegimeInputs = { vix: 18.5, hyOasBps: 380, termSpreadBps: 45 };
      expect(detectMacroRegime(inputs)).toEqual(detectMacroRegime(inputs));
    });
  });

  it('exports DEFAULT_MACRO_REGIME_THRESHOLDS with sensible defaults', () => {
    expect(DEFAULT_MACRO_REGIME_THRESHOLDS.vixPanicMin).toBe(35);
    expect(DEFAULT_MACRO_REGIME_THRESHOLDS.hyOasBlowout).toBe(700);
  });
});
