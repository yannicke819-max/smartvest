import {
  computeMicroFeatures,
  evaluateMicroTrigger,
  forwardReturnNet,
  PriceSample,
} from '../micro-momentum.helper';

// Série à cadence 1s (ts en ms).
function series(prices: number[], stepMs = 1000, t0 = 1_000_000): PriceSample[] {
  return prices.map((price, i) => ({ ts: t0 + i * stepMs, price }));
}

describe('micro-momentum.helper', () => {
  describe('computeMicroFeatures', () => {
    it('run haussier complet : runLength = nb de pas montants', () => {
      // 100 → 100.1 → 100.2 → 100.3 : 3 pas montants consécutifs
      const f = computeMicroFeatures(series([100, 100.1, 100.2, 100.3]));
      expect(f.runLength).toBe(3);
      expect(f.runStartPrice).toBe(100);
      expect(f.lastPrice).toBe(100.3);
      // (100.3-100)/100 = 0.003 sur 3s → 0.001 /s
      expect(f.velocityPctPerS).toBeCloseTo(0.001, 6);
    });

    it('dernier pas baissier → runLength 0, vitesse 0', () => {
      const f = computeMicroFeatures(series([100, 100.2, 100.1]));
      expect(f.runLength).toBe(0);
      expect(f.velocityPctPerS).toBe(0);
      expect(f.accelerationPctPerS2).toBeNull();
    });

    it('ne compte que le run FINAL (rupture au milieu)', () => {
      // monte, redescend, remonte 2 pas → seul le dernier run (2) compte
      const f = computeMicroFeatures(series([100, 101, 99, 99.5, 100]));
      expect(f.runLength).toBe(2);
    });

    it('accélération positive si la 2e moitié monte plus vite', () => {
      // pas: +0.1, +0.1, +0.5, +0.5 → run 4, accel > 0
      const f = computeMicroFeatures(series([100, 100.1, 100.2, 100.7, 101.2]));
      expect(f.runLength).toBe(4);
      expect(f.accelerationPctPerS2).not.toBeNull();
      expect(f.accelerationPctPerS2!).toBeGreaterThan(0);
    });

    it('run de 2 → accélération null (pas assez de points)', () => {
      const f = computeMicroFeatures(series([100, 100.1, 100.2]));
      expect(f.runLength).toBe(2);
      expect(f.accelerationPctPerS2).toBeNull();
    });

    it('série vide ou singleton → neutre', () => {
      expect(computeMicroFeatures([]).runLength).toBe(0);
      expect(computeMicroFeatures(series([100])).runLength).toBe(0);
    });
  });

  describe('evaluateMicroTrigger', () => {
    const cfg = { minRunLength: 3, minVelocityPctPerS: 0.0005 };

    it('déclenche si run ET vitesse au-dessus des seuils', () => {
      const r = evaluateMicroTrigger(series([100, 100.1, 100.2, 100.3]), cfg);
      expect(r.triggered).toBe(true);
    });

    it('ne déclenche pas si run trop court', () => {
      const r = evaluateMicroTrigger(series([100, 100.2]), cfg);
      expect(r.triggered).toBe(false);
    });

    it('ne déclenche pas si vitesse trop faible (run long mais plat)', () => {
      // 5 pas mais +0.001% chacun → vitesse sous le seuil
      const r = evaluateMicroTrigger(series([100, 100.001, 100.002, 100.003, 100.004]), cfg);
      expect(r.runLength).toBe(4);
      expect(r.triggered).toBe(false);
    });
  });

  describe('forwardReturnNet', () => {
    it('soustrait les frais round-trip', () => {
      // +0.5% brut, frais 0.2% → +0.3% net
      const r = forwardReturnNet(100, 100.5, 0.002)!;
      expect(r.retPct).toBeCloseTo(0.005, 6);
      expect(r.retNetPct).toBeCloseTo(0.003, 6);
    });

    it('gain brut < frais → net négatif (le piège haute fréquence)', () => {
      // +0.1% brut < 0.2% frais → net négatif
      const r = forwardReturnNet(100, 100.1, 0.002)!;
      expect(r.retNetPct).toBeLessThan(0);
    });

    it('entry <= 0 → null', () => {
      expect(forwardReturnNet(0, 100, 0.002)).toBeNull();
    });
  });
});
