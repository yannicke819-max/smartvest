/**
 * Micro-momentum — helpers purs pour l'expérience shadow d'entrée haute fréquence.
 *
 * On évalue une série d'échantillons {ts, price} (du plus ancien au plus récent,
 * cadence ~secondes) et on en dérive :
 *   - runLength : nb d'échantillons STRICTEMENT haussiers consécutifs finissant
 *     sur le dernier échantillon (price[i] > price[i-1]).
 *   - velocityPctPerS : vitesse de croissance sur le run, en %/seconde.
 *   - accelerationPctPerS2 : variation de vitesse (1re vs 2e moitié du run) /Δt.
 *
 * `evaluateMicroTrigger` déclenche si runLength >= minRunLength ET
 * velocityPctPerS >= minVelocityPctPerS. Tout est pur/déterministe — aucune I/O.
 */

export interface PriceSample {
  /** Epoch ms. */
  ts: number;
  price: number;
}

export interface MicroFeatures {
  runLength: number;
  velocityPctPerS: number;
  /** null si run < 3 échantillons (pas de 2 demi-segments pour estimer l'accel). */
  accelerationPctPerS2: number | null;
  runStartPrice: number;
  lastPrice: number;
}

export interface MicroTriggerConfig {
  minRunLength: number;
  minVelocityPctPerS: number;
}

export interface MicroTriggerResult extends MicroFeatures {
  triggered: boolean;
}

/** Longueur du run haussier consécutif finissant au dernier échantillon. */
function trailingUpRun(samples: PriceSample[]): number {
  let run = 0;
  for (let i = samples.length - 1; i > 0; i--) {
    if (samples[i].price > samples[i - 1].price) run++;
    else break;
  }
  return run;
}

/** Vitesse moyenne en %/s entre deux échantillons (a plus ancien, b plus récent). */
function velocityPctPerS(a: PriceSample, b: PriceSample): number {
  const dtSec = (b.ts - a.ts) / 1000;
  if (dtSec <= 0 || a.price <= 0) return 0;
  const retPct = (b.price - a.price) / a.price;
  return retPct / dtSec;
}

/**
 * Calcule les features micro-momentum sur la fin haussière de la série.
 * Si aucun run haussier (dernier échantillon non haussier) → runLength=0,
 * vitesse 0, accel null.
 */
export function computeMicroFeatures(samples: PriceSample[]): MicroFeatures {
  const n = samples.length;
  if (n < 2) {
    const p = n === 1 ? samples[0].price : 0;
    return { runLength: 0, velocityPctPerS: 0, accelerationPctPerS2: null, runStartPrice: p, lastPrice: p };
  }
  const runLength = trailingUpRun(samples);
  const last = samples[n - 1];
  if (runLength === 0) {
    return {
      runLength: 0,
      velocityPctPerS: 0,
      accelerationPctPerS2: null,
      runStartPrice: last.price,
      lastPrice: last.price,
    };
  }
  // Le run couvre les indices [n-1-runLength, n-1].
  const startIdx = n - 1 - runLength;
  const runStart = samples[startIdx];
  const velocity = velocityPctPerS(runStart, last);

  // Accélération : vélocité 2e moitié − vélocité 1re moitié, /Δt total.
  let acceleration: number | null = null;
  if (runLength >= 3) {
    const midIdx = startIdx + Math.floor(runLength / 2);
    const mid = samples[midIdx];
    const v1 = velocityPctPerS(runStart, mid);
    const v2 = velocityPctPerS(mid, last);
    const dtSec = (last.ts - runStart.ts) / 1000;
    if (dtSec > 0) acceleration = (v2 - v1) / dtSec;
  }

  return {
    runLength,
    velocityPctPerS: velocity,
    accelerationPctPerS2: acceleration,
    runStartPrice: runStart.price,
    lastPrice: last.price,
  };
}

export function evaluateMicroTrigger(
  samples: PriceSample[],
  cfg: MicroTriggerConfig,
): MicroTriggerResult {
  const f = computeMicroFeatures(samples);
  const triggered = f.runLength >= cfg.minRunLength && f.velocityPctPerS >= cfg.minVelocityPctPerS;
  return { ...f, triggered };
}

/**
 * Forward-return net de frais. ret = (priceAtHorizon - entry) / entry ;
 * net = ret − feeRoundtripPct. Retourne null si entry <= 0.
 */
export function forwardReturnNet(
  entry: number,
  priceAtHorizon: number,
  feeRoundtripPct: number,
): { retPct: number; retNetPct: number } | null {
  if (entry <= 0) return null;
  const retPct = (priceAtHorizon - entry) / entry;
  return { retPct, retNetPct: retPct - feeRoundtripPct };
}
