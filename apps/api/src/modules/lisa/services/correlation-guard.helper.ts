/**
 * Cross-position correlation guard — pure helper, no I/O.
 *
 * Évite la cascade de SL groupés (incident 24/05 : 4 SL crypto en 3 min sur
 * SOL/ETH/XRP/BTC/BNB tous corrélés). Avant d'ouvrir une nouvelle position,
 * on calcule la corrélation rolling 30j entre le candidat et les positions
 * déjà ouvertes. Si trop concentré, on refuse.
 *
 * Méthode : Pearson sur log-returns daily 30j. Seuil défaut 0.70 (= moyen-fort
 * coupling). Skip si < 10 observations (pas assez fiable).
 */

/**
 * Compute log returns from a price series.
 *   returns[i] = ln(prices[i+1] / prices[i])
 * Retourne array de taille N-1. Si prices contient ≤ 1 valeur → array vide.
 */
export function computeLogReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1];
    const p1 = prices[i];
    if (p0 > 0 && p1 > 0 && Number.isFinite(p0) && Number.isFinite(p1)) {
      out.push(Math.log(p1 / p0));
    }
  }
  return out;
}

/**
 * Pearson correlation coefficient sur 2 series de returns alignées.
 * Retourne null si :
 *  - series de tailles différentes
 *  - moins de 10 observations (insuffisant)
 *  - variance nulle (constante) sur une des deux series → corrélation indéfinie
 */
export function computePearsonCorrelation(a: number[], b: number[]): number | null {
  if (a.length !== b.length) return null;
  if (a.length < 10) return null;
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const dA = a[i] - meanA;
    const dB = b[i] - meanB;
    num += dA * dB;
    denA += dA * dA;
    denB += dB * dB;
  }
  if (denA < 1e-12 || denB < 1e-12) return null;
  const r = num / Math.sqrt(denA * denB);
  return Math.max(-1, Math.min(1, r));
}

export interface OpenPositionPrices {
  symbol: string;
  prices: number[];        // 30 daily closes (les plus récents en dernier)
}

export interface CorrelationGuardConfig {
  threshold: number;       // ex 0.70 = au-dessus = trop corrélé
  minObservations: number; // ex 10 (= 10 jours de returns)
}

export const DEFAULT_CORRELATION_GUARD_CONFIG: CorrelationGuardConfig = {
  threshold: 0.70,
  minObservations: 10,
};

export interface CorrelationAssessment {
  reject: boolean;
  reason: string;
  avgCorr: number | null;
  maxCorr: number | null;
  perPosition: Array<{ symbol: string; corr: number | null }>;
}

/**
 * Évalue si l'ouverture d'une nouvelle position serait trop corrélée aux
 * positions déjà ouvertes. Logique :
 *  1. Aucun open → autoriser (rien à comparer)
 *  2. Pour chaque open, compute Pearson(candidate_returns, open_returns)
 *  3. avg(|corr|) > threshold → REFUSER (corrélation peut être négative aussi
 *     mais elle expose à des cascades reverse — on prend l'absolue valeur)
 *  4. Sinon → autoriser
 *
 * Note : on filtre les corr=null (pas assez de data) avant la moyenne.
 * Si toutes sont null → autoriser par défaut (pas d'info pour refuser).
 */
export function assessCorrelationRisk(
  candidatePrices: number[],
  openPositions: OpenPositionPrices[],
  cfg: CorrelationGuardConfig = DEFAULT_CORRELATION_GUARD_CONFIG,
): CorrelationAssessment {
  if (openPositions.length === 0) {
    return { reject: false, reason: 'no_open_positions', avgCorr: null, maxCorr: null, perPosition: [] };
  }
  const candReturns = computeLogReturns(candidatePrices);
  if (candReturns.length < cfg.minObservations) {
    return {
      reject: false,
      reason: `candidate_insufficient_history (${candReturns.length}/${cfg.minObservations} returns)`,
      avgCorr: null, maxCorr: null, perPosition: [],
    };
  }
  const perPosition: Array<{ symbol: string; corr: number | null }> = [];
  for (const op of openPositions) {
    const opReturns = computeLogReturns(op.prices);
    if (opReturns.length < cfg.minObservations) {
      perPosition.push({ symbol: op.symbol, corr: null });
      continue;
    }
    // Aligne les longueurs sur le min des deux
    const n = Math.min(candReturns.length, opReturns.length);
    const a = candReturns.slice(-n);
    const b = opReturns.slice(-n);
    const corr = computePearsonCorrelation(a, b);
    perPosition.push({ symbol: op.symbol, corr });
  }
  const validCorrs = perPosition
    .map((p) => p.corr)
    .filter((c): c is number => c != null)
    .map((c) => Math.abs(c));
  if (validCorrs.length === 0) {
    return {
      reject: false,
      reason: 'no_valid_correlations_computable',
      avgCorr: null, maxCorr: null, perPosition,
    };
  }
  const avgCorr = validCorrs.reduce((s, c) => s + c, 0) / validCorrs.length;
  const maxCorr = Math.max(...validCorrs);
  const reject = avgCorr > cfg.threshold;
  return {
    reject,
    reason: reject
      ? `avg_correlation_${avgCorr.toFixed(2)}_above_threshold_${cfg.threshold.toFixed(2)}`
      : `avg_correlation_${avgCorr.toFixed(2)}_below_threshold_${cfg.threshold.toFixed(2)}`,
    avgCorr,
    maxCorr,
    perPosition,
  };
}

/**
 * Parse config from env vars.
 */
export function parseCorrelationGuardConfig(env: {
  CORRELATION_GUARD_THRESHOLD?: string | undefined;
  CORRELATION_GUARD_MIN_OBS?: string | undefined;
}): CorrelationGuardConfig {
  const thRaw = Number.parseFloat(env.CORRELATION_GUARD_THRESHOLD ?? '');
  const minRaw = Number.parseInt(env.CORRELATION_GUARD_MIN_OBS ?? '', 10);
  return {
    threshold: Number.isFinite(thRaw) && thRaw > 0 && thRaw <= 1 ? thRaw : DEFAULT_CORRELATION_GUARD_CONFIG.threshold,
    minObservations: Number.isFinite(minRaw) && minRaw >= 5 && minRaw <= 60 ? minRaw : DEFAULT_CORRELATION_GUARD_CONFIG.minObservations,
  };
}
