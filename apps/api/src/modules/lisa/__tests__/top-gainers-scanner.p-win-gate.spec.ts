/**
 * PR #4 — Tests du pWin gate dans le scanner Gainers.
 *
 * Logique pure : on simule la décision du gate selon
 *   - cfg.gainers_p_win_gate_enabled (on/off)
 *   - cfg.gainers_min_p_win (threshold)
 *   - probability.fallback (modèle prêt ou pas)
 *   - probability.pWin (estimation ML)
 *
 * Le scanner DOIT :
 *   - bypass complet du gate si gate désactivé (default false)
 *   - bypass si probability.fallback=true (sample insuffisant OU AUC bas)
 *   - skip candidat si pWin < threshold (gate strict)
 *   - laisser passer si pWin >= threshold
 */

interface CfgRow {
  gainers_p_win_gate_enabled?: boolean;
  gainers_min_p_win?: number | null;
}

interface ProbabilityResult {
  pWin: number;
  fallback: boolean;
  modelVersion: string;
  sampleSize: number;
}

type Decision = 'pass' | 'skip' | 'gate_disabled' | 'fallback_bypass';

function evaluatePWinGate(
  cfg: CfgRow,
  probability: ProbabilityResult | null,
): Decision {
  const enabled = cfg.gainers_p_win_gate_enabled === true;
  if (!enabled) return 'gate_disabled';
  if (!probability) return 'gate_disabled'; // service down — fail-open
  if (probability.fallback) return 'fallback_bypass';
  const minPWin = cfg.gainers_min_p_win != null
    ? Math.max(0, Math.min(1, Number(cfg.gainers_min_p_win)))
    : 0.50;
  return probability.pWin < minPWin ? 'skip' : 'pass';
}

describe('TopGainersScannerService — pWin gate (PR #4)', () => {
  describe('Gate ON / OFF', () => {
    it('disabled by default → bypass', () => {
      const probability: ProbabilityResult = {
        pWin: 0.30, // even very low pWin
        fallback: false,
        modelVersion: 'v1730000000',
        sampleSize: 100,
      };
      expect(evaluatePWinGate({}, probability)).toBe('gate_disabled');
    });

    it('explicitly disabled → bypass', () => {
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: false },
          { pWin: 0.10, fallback: false, modelVersion: 'v1', sampleSize: 100 },
        ),
      ).toBe('gate_disabled');
    });

    it('enabled + good pWin → pass', () => {
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: 0.55 },
          { pWin: 0.65, fallback: false, modelVersion: 'v1', sampleSize: 100 },
        ),
      ).toBe('pass');
    });

    it('enabled + low pWin → skip', () => {
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: 0.55 },
          { pWin: 0.40, fallback: false, modelVersion: 'v1', sampleSize: 100 },
        ),
      ).toBe('skip');
    });
  });

  describe('Fallback bypass (modèle pas prêt)', () => {
    it('sample insuffisant (n<30) → fallback_bypass', () => {
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: 0.55 },
          { pWin: 0.50, fallback: true, modelVersion: 'none', sampleSize: 12 },
        ),
      ).toBe('fallback_bypass');
    });

    it('AUC bas (modèle non discriminant) → fallback_bypass', () => {
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: 0.55 },
          // service.estimateProbability set fallback=true if auc < 0.55
          { pWin: 0.51, fallback: true, modelVersion: 'v1', sampleSize: 100 },
        ),
      ).toBe('fallback_bypass');
    });

    it('probability service unavailable → gate_disabled (fail-open)', () => {
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: 0.55 },
          null,
        ),
      ).toBe('gate_disabled');
    });
  });

  describe('Threshold edge cases', () => {
    it('pWin = threshold (exact match) → pass (>=)', () => {
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: 0.50 },
          { pWin: 0.50, fallback: false, modelVersion: 'v1', sampleSize: 100 },
        ),
      ).toBe('pass');
    });

    it('threshold null → fallback default 0.50', () => {
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: null },
          { pWin: 0.49, fallback: false, modelVersion: 'v1', sampleSize: 100 },
        ),
      ).toBe('skip');
    });

    it('threshold clamp >1 → 1', () => {
      // No candidate can ever pass a threshold of 1.0
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: 1.5 },
          { pWin: 0.99, fallback: false, modelVersion: 'v1', sampleSize: 100 },
        ),
      ).toBe('skip');
    });

    it('threshold clamp <0 → 0', () => {
      // Threshold 0 → tout passe
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: -0.5 },
          { pWin: 0.01, fallback: false, modelVersion: 'v1', sampleSize: 100 },
        ),
      ).toBe('pass');
    });
  });

  describe('Scenarios production', () => {
    it('Phase test (RCFT en cours) — gate enabled but model fallback → bypass automatique', () => {
      // User active le gate à T+0, mais le modèle a 18 trades fermés (< 30)
      // → fallback automatique, scanner ne bloque pas (apprentissage continue)
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: 0.55 },
          { pWin: 0.50, fallback: true, modelVersion: 'none', sampleSize: 18 },
        ),
      ).toBe('fallback_bypass');
    });

    it('Production mature — model converged (n=200, auc=0.71) → gate filtre actif', () => {
      // Setup A+ accepté
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: 0.55 },
          { pWin: 0.78, fallback: false, modelVersion: 'v1735000000', sampleSize: 200 },
        ),
      ).toBe('pass');

      // Setup B/C rejeté
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: 0.55 },
          { pWin: 0.42, fallback: false, modelVersion: 'v1735000000', sampleSize: 200 },
        ),
      ).toBe('skip');
    });

    it('Conservative threshold (0.65) — filtre que les très bons setups', () => {
      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: 0.65 },
          { pWin: 0.60, fallback: false, modelVersion: 'v1', sampleSize: 100 },
        ),
      ).toBe('skip'); // 60% < 65% threshold conservateur

      expect(
        evaluatePWinGate(
          { gainers_p_win_gate_enabled: true, gainers_min_p_win: 0.65 },
          { pWin: 0.72, fallback: false, modelVersion: 'v1', sampleSize: 100 },
        ),
      ).toBe('pass');
    });
  });
});
