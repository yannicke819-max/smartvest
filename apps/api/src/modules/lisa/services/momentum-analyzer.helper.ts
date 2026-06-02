/**
 * Momentum Analyzer — Phase 2 du refactor scanner Option C.
 *
 * Analyse time-series sur les dernières candles intraday d'un candidat :
 *   - gradientPctPerMin  : vitesse moyenne de progression (% par minute)
 *   - acceleration       : changement de vitesse récente vs ancienne
 *   - volumeMomentum     : ratio volume récent vs volume earlier
 *   - verticalityScore   : pump vertical vs progression échelonnée
 *   - risingScore        : score composite 0-1 résumant la dynamique
 *
 * Le risingScore permet à Mistral de distinguer :
 *   - "rising 5%" (= gradient positif, volume montant, accel positive)
 *   - "stalled at 5%" (= gradient proche de 0)
 *   - "rolling over from 8%" (= gradient négatif récent après hausse)
 *
 * Pure helpers : reçoivent un tableau de candles (timestamp + ohlcv) et
 * retournent les métriques. Aucun appel réseau ici — le caller fetch les
 * candles séparément (intraday-router ou EODHD).
 */

export interface Candle {
  timestamp: number; // unix epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MomentumMetrics {
  /** Gradient moyen (% par minute) sur la fenêtre complète. Positif = rising, négatif = falling. */
  gradientPctPerMin: number;
  /** Différence gradient(récent 1/3) - gradient(ancien 1/3). Positif = en accélération. */
  acceleration: number;
  /** volume_recent_third / volume_earlier_third. >1 = momentum volume monte, <1 = descend. */
  volumeMomentum: number;
  /** Score 0-1 : 1 = pump vertical (range high-low concentré dans peu de candles), 0 = progression douce. */
  verticalityScore: number;
  /** Score composite 0-1 résumant la dynamique. Utilisé comme signal LLM. */
  risingScore: number;
  /** Nombre de candles utilisées (pour debug / sanity). */
  sampleSize: number;
}

const NEUTRAL_METRICS: MomentumMetrics = {
  gradientPctPerMin: 0,
  acceleration: 0,
  volumeMomentum: 1,
  verticalityScore: 0,
  risingScore: 0.5,
  sampleSize: 0,
};

/**
 * Computes momentum metrics from a series of intraday candles.
 *
 * Conventions :
 *  - candles triées par timestamp CROISSANT (plus ancien → plus récent)
 *  - retourne NEUTRAL si <3 candles (échantillon insuffisant)
 *  - le risingScore est dans [0, 1] :
 *      0   = clairement reversing (gradient négatif fort)
 *      0.5 = idle / neutre
 *      1   = clairement rising (gradient + accel + volume tous positifs)
 */
export function computeMomentumMetrics(candles: Candle[]): MomentumMetrics {
  if (!Array.isArray(candles) || candles.length < 3) return { ...NEUTRAL_METRICS };

  // Trie défensivement par timestamp
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const n = sorted.length;
  const first = sorted[0];
  const last = sorted[n - 1];
  const spanMin = Math.max(1, (last.timestamp - first.timestamp) / 60);

  // 1. Gradient global (% par min) sur la fenêtre entière
  const gradientPctPerMin = first.close > 0
    ? ((last.close - first.close) / first.close) * 100 / spanMin
    : 0;

  // 2. Acceleration : gradient récent (tiers final) - gradient ancien (tiers initial)
  const third = Math.floor(n / 3);
  const earlySlice = sorted.slice(0, Math.max(2, third));
  const recentSlice = sorted.slice(n - Math.max(2, third));
  const earlyGradient = computeSliceGradient(earlySlice);
  const recentGradient = computeSliceGradient(recentSlice);
  const acceleration = recentGradient - earlyGradient;

  // 3. Volume momentum : volume récent / volume ancien
  const earlyVol = earlySlice.reduce((s, c) => s + c.volume, 0) / Math.max(1, earlySlice.length);
  const recentVol = recentSlice.reduce((s, c) => s + c.volume, 0) / Math.max(1, recentSlice.length);
  const volumeMomentum = earlyVol > 0 ? recentVol / earlyVol : 1;

  // 4. Verticality : range (high-low) / nombre de candles non-doji
  // Un pump vertical concentre le mouvement dans peu de candles.
  const maxHigh = Math.max(...sorted.map((c) => c.high));
  const minLow = Math.min(...sorted.map((c) => c.low));
  const totalRange = maxHigh - minLow;
  const movingCandles = sorted.filter((c) => Math.abs(c.close - c.open) / Math.max(1e-9, c.open) > 0.001).length;
  const verticalityScore = totalRange > 0 && movingCandles > 0
    ? Math.min(1, totalRange / minLow / Math.max(1, movingCandles) * 100)
    : 0;

  // 5. Rising score composite (0-1)
  //   gradient positif fort → contribution +
  //   acceleration positive → contribution +
  //   volume momentum > 1   → contribution +
  //   verticality élevée    → contribution - (= pump-and-dump)
  const gradComp = sigmoid(gradientPctPerMin * 4); // sensible à ±0.25%/min
  const accelComp = sigmoid(acceleration * 4);
  const volComp = sigmoid((volumeMomentum - 1) * 2); // 1 = neutre, >1 = bonus
  const vertPenalty = Math.max(0, Math.min(1, verticalityScore));
  const risingScore = Math.max(0, Math.min(1,
    0.40 * gradComp
    + 0.30 * accelComp
    + 0.20 * volComp
    - 0.10 * vertPenalty
    + 0.20 // base : si tout neutre on est à 0.5
  ));

  return {
    gradientPctPerMin,
    acceleration,
    volumeMomentum,
    verticalityScore,
    risingScore,
    sampleSize: n,
  };
}

/** Sigmoid logistique pour mapper R → (0,1). */
function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x > 10) return 1;
  if (x < -10) return 0;
  return 1 / (1 + Math.exp(-x));
}

/** Gradient (%/min) sur une tranche : (close_last - close_first) / close_first / span_min × 100. */
function computeSliceGradient(slice: Candle[]): number {
  if (slice.length < 2) return 0;
  const first = slice[0];
  const last = slice[slice.length - 1];
  const spanMin = Math.max(1, (last.timestamp - first.timestamp) / 60);
  if (first.close <= 0) return 0;
  return ((last.close - first.close) / first.close) * 100 / spanMin;
}

/**
 * Classifie un candidat en bucket selon les métriques (utilisé Phase 3).
 * Exposé ici pour facilité de test, mais le bucket est computé Phase 3.
 */
export function classifyBucket(
  changePct: number,
  closeToHighRatio: number,
  metrics: MomentumMetrics,
): 'sweet_spot_rising' | 'peak_parabolic' | 'early_mover' | 'stalled' | 'reversing' {
  // Reversing : gradient récent négatif sur fenêtre récente
  if (metrics.gradientPctPerMin < -0.1) return 'reversing';
  // Peak parabolic : changePct élevé + au peak
  if (changePct > 12 && closeToHighRatio > 0.95) return 'peak_parabolic';
  // Sweet spot rising : changePct entre 3 et 12 + dynamique positive
  if (changePct >= 3 && changePct <= 12 && metrics.risingScore > 0.55) return 'sweet_spot_rising';
  // Early mover : petit move avec accel positive (peut décoller)
  if (changePct >= 0.5 && changePct < 3 && metrics.acceleration > 0) return 'early_mover';
  return 'stalled';
}
