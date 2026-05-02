/**
 * ADR-005 Step 9 — Power analysis pour shadow run validation.
 *
 * Test de proportion deux queues vs H₀ : win_rate = 0.50 (aléatoire).
 * Référence : Cohen (1988) "Statistical Power Analysis for the Behavioral Sciences".
 *
 * Spec verrouillée maître d'œuvre :
 *   power = 0.90, α = 0.05, Cohen d = 0.3 minimum
 *   MIN(n_required, 2000 trades OR 45 days)
 *   Early-stop : p < 0.01 ET n ≥ 500 OU p > 0.50 ET n ≥ 800
 */

export interface ProportionTestInput {
  /** Nombre total de trades fermés (avec PnL réalisé). */
  n: number;
  /** Nombre de wins (PnL > 0). */
  wins: number;
}

export interface ProportionTestResult {
  /** Win rate observé. */
  winRate: number;
  /** Statistique Z (test bilatéral vs p₀ = 0.5). */
  zStat: number;
  /** p-value approchée bilatérale. */
  pValue: number;
  /** Intervalle de confiance Wilson 95% [low, high]. */
  ci95Wilson: [number, number];
  /** Recommandation basée sur règles early-stop ADR-005. */
  recommendation: 'CONTINUE' | 'EARLY_STOP_REJECT_NULL' | 'EARLY_STOP_NO_EFFECT' | 'INSUFFICIENT_SAMPLES';
}

/**
 * CDF de la loi normale standardisée. Approximation Abramowitz & Stegun 26.2.17.
 * Erreur max < 7.5e-8 sur l'intervalle complet.
 */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const absZ = Math.abs(z);
  if (absZ > 8) return sign === 1 ? 1 : 0;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * absZ / Math.SQRT2);
  const erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-(absZ * absZ) / 2);
  return 0.5 * (1 + sign * erf);
}

/** Wilson 95% confidence interval for a proportion. */
export function wilsonInterval95(p: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/**
 * Test bilatéral H₀ : p = 0.5 sur win-rate observé.
 * Retourne stats + recommandation early-stop.
 */
export function proportionTest(input: ProportionTestInput): ProportionTestResult {
  const { n, wins } = input;

  if (n < 30) {
    return {
      winRate: n > 0 ? wins / n : 0,
      zStat: 0,
      pValue: 1,
      ci95Wilson: n > 0 ? wilsonInterval95(wins / n, n) : [0, 0],
      recommendation: 'INSUFFICIENT_SAMPLES',
    };
  }

  const p = wins / n;
  const p0 = 0.5;
  const se = Math.sqrt((p0 * (1 - p0)) / n);
  const z = (p - p0) / se;

  // p-value bilatérale : 2 × P(Z > |z|)
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));

  // Early-stop rules ADR-005 :
  //   p < 0.01 AND n ≥ 500 → reject null (algo significativement non-aléatoire)
  //   p > 0.50 AND n ≥ 800 → no effect (algo indistinguable de aléatoire)
  let recommendation: ProportionTestResult['recommendation'] = 'CONTINUE';
  if (pValue < 0.01 && n >= 500) recommendation = 'EARLY_STOP_REJECT_NULL';
  else if (pValue > 0.50 && n >= 800) recommendation = 'EARLY_STOP_NO_EFFECT';

  return {
    winRate: p,
    zStat: z,
    pValue,
    ci95Wilson: wilsonInterval95(p, n),
    recommendation,
  };
}

/**
 * Sample size requis G*Power test de proportion deux queues, vs H₀=0.5.
 * Formule approchée : n = (z_α/2 + z_β)² × p(1-p) / δ²
 *   où δ = effect size (e.g. 0.05 pour détecter 0.55 vs 0.50)
 *   z_α/2 = 1.96 (α=0.05 bilatéral)
 *   z_β = 1.282 (power=0.90)
 */
export function requiredSampleSize(effectDelta: number, p0 = 0.5): number {
  const zAlpha = 1.96;
  const zBeta = 1.282;
  const denom = effectDelta * effectDelta;
  if (denom === 0) return Infinity;
  return Math.ceil(((zAlpha + zBeta) ** 2 * p0 * (1 - p0)) / denom);
}
