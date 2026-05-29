/**
 * Velocity gate helper — pure functions for price velocity/acceleration analysis.
 *
 * Sweeney (1996) inspired but applied to falling-knife detection on entry.
 *
 * Velocity = price slope (%/min) via linear regression on last N candles.
 * Acceleration = (velocity 2nd half) - (velocity 1st half), in (%/min²).
 *
 * Reject pattern : velocity < negativeVelocityMin OR (velocity < 0 AND accel < 0)
 * = "le prix tombe vite ET la chute accélère" = dead-cat-bounce in progress.
 *
 * Pure & deterministic — no I/O, no logger, no DB. Testable directly.
 */

export interface VelocityFeatures {
  velocityPctPerMin: number;       // signed slope from linear regression (e.g. -2.5 = chute -2.5%/min)
  accelerationPctPerMin2: number;  // signed accel (v2 - v1 / dtMin)
  rSquared: number;                // quality of linear fit (0-1)
  n: number;                       // number of candles used
  firstClose: number;
  lastClose: number;
  spanMin: number;                 // minutes elapsed first to last
}

export interface VelocityGateConfig {
  minNegativeVelocityPctPerMin: number;  // ex: -2.0 → reject if velocity < -2%/min
  minNegativeAccelPctPerMin2: number;    // ex: -0.5 → reject if v0 < 0 AND accel < -0.5
  minCandlesRequired: number;            // ex: 5 → besoin au moins 5 points
}

export interface PricePoint {
  timestampSec: number;
  close: number;
}

/**
 * Linear regression close vs minutes elapsed.
 * Returns slope in price-units/min, then converted to %/min using first close.
 */
function linearSlope(points: PricePoint[]): { slopeUnitsPerMin: number; intercept: number; rSquared: number } {
  if (points.length < 2) return { slopeUnitsPerMin: 0, intercept: 0, rSquared: 0 };
  const t0 = points[0].timestampSec;
  const xs = points.map((p) => (p.timestampSec - t0) / 60); // minutes
  const ys = points.map((p) => p.close);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumX2 = xs.reduce((acc, x) => acc + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slopeUnitsPerMin: 0, intercept: ys[0], rSquared: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  // R² = 1 - SSres / SStot
  const meanY = sumY / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const yPred = slope * xs[i] + intercept;
    ssRes += (ys[i] - yPred) ** 2;
    ssTot += (ys[i] - meanY) ** 2;
  }
  const rSquared = ssTot > 0 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0;
  return { slopeUnitsPerMin: slope, intercept, rSquared };
}

/**
 * Compute velocity + acceleration from a series of close prices.
 * If candles span < 2 min or any close <= 0 → return null (insufficient data).
 */
export function computeVelocityFeatures(points: PricePoint[]): VelocityFeatures | null {
  if (points.length < 2) return null;
  if (points.some((p) => !Number.isFinite(p.close) || p.close <= 0)) return null;

  const firstClose = points[0].close;
  const lastClose = points[points.length - 1].close;
  const spanMin = (points[points.length - 1].timestampSec - points[0].timestampSec) / 60;
  if (spanMin <= 0) return null;

  const { slopeUnitsPerMin, rSquared } = linearSlope(points);
  // Convert slope (units/min) to %/min relative to first close
  const velocityPctPerMin = (slopeUnitsPerMin / firstClose) * 100;

  // Acceleration = (slope 2nd half) - (slope 1st half), divided by dt(mid-to-mid)
  let accelerationPctPerMin2 = 0;
  if (points.length >= 4) {
    const mid = Math.floor(points.length / 2);
    const half1 = points.slice(0, mid + 1);
    const half2 = points.slice(mid);
    const s1 = linearSlope(half1).slopeUnitsPerMin;
    const s2 = linearSlope(half2).slopeUnitsPerMin;
    const v1Pct = (s1 / firstClose) * 100;
    const v2Pct = (s2 / firstClose) * 100;
    const t1mid = (half1[Math.floor(half1.length / 2)].timestampSec - points[0].timestampSec) / 60;
    const t2mid = (half2[Math.floor(half2.length / 2)].timestampSec - points[0].timestampSec) / 60;
    const dtMid = t2mid - t1mid;
    if (dtMid > 0) {
      accelerationPctPerMin2 = (v2Pct - v1Pct) / dtMid;
    }
  }

  return {
    velocityPctPerMin,
    accelerationPctPerMin2,
    rSquared,
    n: points.length,
    firstClose,
    lastClose,
    spanMin,
  };
}

export interface VelocityGateDecision {
  reject: boolean;
  reason: string | null;
  features: VelocityFeatures | null;
}

/**
 * Decision : reject if (velocity < threshold) OR (velocity < 0 AND accel < threshold).
 * Le 2e cas catch les "death spiral" même si velocity n'a pas atteint le seuil dur.
 */
export function evaluateVelocityGate(
  points: PricePoint[],
  cfg: VelocityGateConfig,
): VelocityGateDecision {
  if (points.length < cfg.minCandlesRequired) {
    return { reject: false, reason: 'insufficient_candles', features: null };
  }
  const features = computeVelocityFeatures(points);
  if (!features) {
    return { reject: false, reason: 'compute_failed', features: null };
  }
  // Rule A : vélocité trop négative
  if (features.velocityPctPerMin < cfg.minNegativeVelocityPctPerMin) {
    return {
      reject: true,
      reason: `velocity ${features.velocityPctPerMin.toFixed(2)}%/min < ${cfg.minNegativeVelocityPctPerMin}%/min`,
      features,
    };
  }
  // Rule B : chute qui s'accélère (vélocité < 0 ET accel négative au-delà du seuil)
  if (
    features.velocityPctPerMin < 0
    && features.accelerationPctPerMin2 < cfg.minNegativeAccelPctPerMin2
  ) {
    return {
      reject: true,
      reason: `acceleration ${features.accelerationPctPerMin2.toFixed(2)}%/min² < ${cfg.minNegativeAccelPctPerMin2} avec velocity ${features.velocityPctPerMin.toFixed(2)}%/min`,
      features,
    };
  }
  return { reject: false, reason: null, features };
}
