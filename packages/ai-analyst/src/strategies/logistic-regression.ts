/**
 * P9 — Logistic regression maison (Newton-Raphson) + AUC + Wilson CI.
 *
 * Implémentation minimale, sans dépendance ML externe :
 *   - Fitter L2-regularized via Newton-Raphson (~50 LoC pur)
 *   - Prédiction sigmoïde
 *   - AUC ROC (sweep threshold + intégration trapèzes)
 *   - Wilson 95% confidence interval pour intervalle de proportion observée
 *
 * Hypothèses :
 *   - Y ∈ {0, 1} (binaire)
 *   - Features X ∈ R^d (numerical, déjà normalisées si nécessaire par le caller)
 *   - Régularisation L2 par défaut λ=0.01 (mitigation overfit sur petit sample)
 *
 * Entièrement déterministe + testable.
 */

export interface LogisticWeights {
  /** Intercept (a.k.a. bias). */
  intercept: number;
  /** Coefficients pour chaque feature, dans le même ordre que `featureNames`. */
  coefficients: Record<string, number>;
  /** Liste ordonnée des noms de features (pour reproductibilité). */
  featureNames: string[];
}

export interface FitOptions {
  /** Régularisation L2 (default 0.01). */
  l2: number;
  /** Maximum d'itérations Newton-Raphson (default 50). */
  maxIter: number;
  /** Tolérance de convergence sur la log-vraisemblance (default 1e-6). */
  tol: number;
}

export interface FitResult {
  weights: LogisticWeights;
  iterations: number;
  converged: boolean;
  finalLogLikelihood: number;
}

const SIGMOID_CLAMP = 1e-12;

export function sigmoid(z: number): number {
  if (z > 30) return 1 - SIGMOID_CLAMP;
  if (z < -30) return SIGMOID_CLAMP;
  return 1 / (1 + Math.exp(-z));
}

/**
 * Prédiction P(Y=1 | x).
 */
export function predict(
  weights: LogisticWeights,
  features: Record<string, number>,
): number {
  let z = weights.intercept;
  for (const name of weights.featureNames) {
    const coef = weights.coefficients[name] ?? 0;
    const x = features[name];
    if (x == null || !Number.isFinite(x)) continue;
    z += coef * x;
  }
  return sigmoid(z);
}

/**
 * Newton-Raphson fitter. Retourne intercept + coefficients par feature.
 *
 * Inputs :
 *   - X : matrice n×d (n samples, d features) — array d'objets
 *   - y : array binaire n
 *   - featureNames : ordre canonique des features dans X
 *
 * Logic mathématique :
 *   - z = X·β + b
 *   - p = σ(z)
 *   - gradient = Xᵀ(p - y) + λβ
 *   - hessian = XᵀWX + λI où W = diag(p(1-p))
 *   - β_new = β - H⁻¹g
 *
 * Converge typiquement en 5-15 itérations sur sample bien conditionné.
 * Fail gracefully (returned converged=false) si Hessian singulière.
 */
export function fitLogistic(
  X: Array<Record<string, number>>,
  y: number[],
  featureNames: string[],
  opts: Partial<FitOptions> = {},
): FitResult {
  const l2 = opts.l2 ?? 0.01;
  const maxIter = opts.maxIter ?? 50;
  const tol = opts.tol ?? 1e-6;

  const n = X.length;
  const d = featureNames.length;
  if (n === 0 || y.length !== n) {
    return {
      weights: { intercept: 0, coefficients: zeroCoefs(featureNames), featureNames },
      iterations: 0,
      converged: false,
      finalLogLikelihood: -Infinity,
    };
  }

  // Construit matrice augmentée [intercept, x1, ..., xd]
  const dPlus = d + 1; // +1 pour intercept
  const XAug: number[][] = X.map((row) => {
    const r: number[] = [1]; // intercept column
    for (const name of featureNames) {
      const v = row[name];
      r.push(Number.isFinite(v) ? v : 0);
    }
    return r;
  });

  // β = [intercept, β1, ..., βd], initialisé à 0
  let beta = new Array<number>(dPlus).fill(0);
  let prevLL = -Infinity;
  let converged = false;
  let iter = 0;

  for (iter = 0; iter < maxIter; iter++) {
    // Forward : p_i = σ(x_iᵀβ)
    const p = new Array<number>(n);
    let logLik = 0;
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < dPlus; j++) z += XAug[i][j] * beta[j];
      p[i] = sigmoid(z);
      // Log-vraisemblance (clampée)
      const pi = Math.max(SIGMOID_CLAMP, Math.min(1 - SIGMOID_CLAMP, p[i]));
      logLik += y[i] === 1 ? Math.log(pi) : Math.log(1 - pi);
    }
    // Pénalisation L2 dans la log-vraisemblance (sauf intercept)
    let l2Pen = 0;
    for (let j = 1; j < dPlus; j++) l2Pen += 0.5 * l2 * beta[j] * beta[j];
    logLik -= l2Pen;

    // Convergence ?
    if (iter > 0 && Math.abs(logLik - prevLL) < tol) {
      converged = true;
      break;
    }
    prevLL = logLik;

    // Gradient g = Xᵀ(p - y) + λβ (sauf intercept)
    const grad = new Array<number>(dPlus).fill(0);
    for (let i = 0; i < n; i++) {
      const diff = p[i] - y[i];
      for (let j = 0; j < dPlus; j++) grad[j] += XAug[i][j] * diff;
    }
    for (let j = 1; j < dPlus; j++) grad[j] += l2 * beta[j];

    // Hessian H = XᵀWX + λI (sauf intercept). H est dPlus×dPlus.
    const H: number[][] = Array.from({ length: dPlus }, () => new Array(dPlus).fill(0));
    for (let i = 0; i < n; i++) {
      const w = p[i] * (1 - p[i]);
      for (let a = 0; a < dPlus; a++) {
        for (let b = 0; b < dPlus; b++) {
          H[a][b] += XAug[i][a] * XAug[i][b] * w;
        }
      }
    }
    for (let j = 1; j < dPlus; j++) H[j][j] += l2;

    // β_new = β - H⁻¹g (résolution H·δ = g via Gauss-Jordan)
    const delta = solveLinearSystem(H, grad);
    if (!delta) {
      // Hessian singulière → pas de convergence safe, on stoppe
      break;
    }
    for (let j = 0; j < dPlus; j++) beta[j] -= delta[j];
  }

  const coefficients: Record<string, number> = {};
  for (let j = 0; j < d; j++) {
    coefficients[featureNames[j]] = beta[j + 1];
  }
  return {
    weights: {
      intercept: beta[0],
      coefficients,
      featureNames: [...featureNames],
    },
    iterations: iter + 1,
    converged,
    finalLogLikelihood: prevLL,
  };
}

/**
 * Résolution Hδ = g via Gauss-Jordan avec pivot partiel. Retourne null si la
 * matrice est singulière (déterminant 0 / pivot tombe à 0).
 */
function solveLinearSystem(H: number[][], g: number[]): number[] | null {
  const n = H.length;
  // Matrice augmentée [H | g]
  const A: number[][] = H.map((row, i) => [...row, g[i]]);
  for (let i = 0; i < n; i++) {
    // Pivot partiel
    let maxRow = i;
    let maxVal = Math.abs(A[i][i]);
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > maxVal) {
        maxVal = Math.abs(A[k][i]);
        maxRow = k;
      }
    }
    if (maxVal < 1e-12) return null; // pivot quasi-nul → singulière
    if (maxRow !== i) [A[i], A[maxRow]] = [A[maxRow], A[i]];

    // Élimination
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const factor = A[k][i] / A[i][i];
      for (let j = i; j <= n; j++) A[k][j] -= factor * A[i][j];
    }
  }
  // Extract solution
  const x = new Array<number>(n);
  for (let i = 0; i < n; i++) x[i] = A[i][n] / A[i][i];
  return x;
}

function zeroCoefs(names: string[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const n of names) c[n] = 0;
  return c;
}

// ─────────────────────────────────────────────────────────────────────
// AUC ROC
// ─────────────────────────────────────────────────────────────────────

/**
 * AUC sous la courbe ROC. Sort les samples par score desc, sweep threshold,
 * intègre TPR vs FPR par règle des trapèzes.
 *
 * Edge cases : tous les y identiques → AUC undefined → retourne 0.5.
 */
export function computeAuc(scores: number[], labels: number[]): number {
  if (scores.length !== labels.length || scores.length === 0) return 0.5;
  const positives = labels.filter((y) => y === 1).length;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return 0.5;

  // Tri par score desc
  const indexed = scores.map((s, i) => ({ s, y: labels[i] }));
  indexed.sort((a, b) => b.s - a.s);

  let tp = 0;
  let fp = 0;
  let prevTpr = 0;
  let prevFpr = 0;
  let auc = 0;

  for (const entry of indexed) {
    if (entry.y === 1) tp++;
    else fp++;
    const tpr = tp / positives;
    const fpr = fp / negatives;
    auc += ((fpr - prevFpr) * (tpr + prevTpr)) / 2;
    prevTpr = tpr;
    prevFpr = fpr;
  }
  return auc;
}

/**
 * Accuracy = (TP+TN)/total au threshold donné (default 0.5).
 */
export function computeAccuracy(
  scores: number[],
  labels: number[],
  threshold = 0.5,
): number {
  if (scores.length !== labels.length || scores.length === 0) return 0;
  let correct = 0;
  for (let i = 0; i < scores.length; i++) {
    const pred = scores[i] >= threshold ? 1 : 0;
    if (pred === labels[i]) correct++;
  }
  return correct / scores.length;
}

// ─────────────────────────────────────────────────────────────────────
// Wilson 95% confidence interval pour proportion
// ─────────────────────────────────────────────────────────────────────

/**
 * Intervalle de confiance Wilson 95% pour une proportion (méthode plus robuste
 * que normale-classique pour petits n ou p proche de 0/1).
 *
 *   center = (p + z²/(2n)) / (1 + z²/n)
 *   margin = z·√(p(1-p)/n + z²/(4n²)) / (1 + z²/n)
 *
 * z = 1.96 pour 95%.
 *
 * Retourne {center, lower, upper}. Si n=0 → {0.5, 0, 1} (max uncertainty).
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  confidenceZ = 1.96,
): { center: number; lower: number; upper: number } {
  if (trials <= 0) return { center: 0.5, lower: 0, upper: 1 };
  const p = successes / trials;
  const z = confidenceZ;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  return {
    center,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}
