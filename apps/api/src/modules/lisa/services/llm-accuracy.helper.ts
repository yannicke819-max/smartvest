/**
 * Pure helpers pour mesurer la justesse des LLMs sur leurs verdicts shadow.
 *
 * Question : sur 100 risk_monitor calls, qui prédit le mieux le PnL réel
 * de la position ? On compare verdict_score (0-1) au outcome_pnl_pct mesuré.
 *
 * Métriques :
 *   - Brier score : Σ (score - outcome_binary)² / N — plus bas = meilleur
 *   - Pearson correlation : corrélation linéaire entre score et pnl
 *   - Accuracy directionnelle : % de fois où score>0.5 ↔ pnl>0
 */

/**
 * Brier score = MSE entre la probabilité prédite et l'outcome binaire.
 * - 0.0 = parfait (prédit 1.0 et outcome=1, ou prédit 0.0 et outcome=0)
 * - 0.25 = baseline (prédit 0.5 → no information)
 * - 1.0 = pire (prédit 1.0 et outcome=0)
 *
 * @param scores tableau de probabilités prédites [0, 1]
 * @param outcomes tableau d'outcomes binaires {0, 1}
 * @returns Brier score, ou null si arrays vides ou inégaux
 */
export function brierScore(scores: number[], outcomes: number[]): number | null {
  if (scores.length === 0 || scores.length !== outcomes.length) return null;
  let sum = 0;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    const o = outcomes[i];
    if (s < 0 || s > 1) continue;
    if (o !== 0 && o !== 1) continue;
    sum += (s - o) ** 2;
  }
  return sum / scores.length;
}

/**
 * Pearson correlation coefficient entre 2 séries.
 * - +1.0 = corrélation linéaire parfaite positive
 * -  0.0 = aucune relation
 * - -1.0 = corrélation négative (LLM prédit l'inverse du réel)
 *
 * @returns r ∈ [-1, 1], ou null si arrays trop petits / variance nulle
 */
export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length < 2 || xs.length !== ys.length) return null;
  const n = xs.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return null;
  return num / den;
}

/**
 * Accuracy directionnelle simple : % de fois où LLM et outcome ont le même sens.
 * Considère que score > 0.5 = "bullish" et outcome > 0 = "win".
 *
 * @returns ratio dans [0, 1], ou null si array vide
 */
export function directionalAccuracy(scores: number[], outcomes: number[]): number | null {
  if (scores.length === 0 || scores.length !== outcomes.length) return null;
  let matches = 0;
  for (let i = 0; i < scores.length; i++) {
    const llmBullish = scores[i] > 0.5;
    const realWin = outcomes[i] > 0;
    if (llmBullish === realWin) matches++;
  }
  return matches / scores.length;
}

/**
 * Parse un verdict risk_monitor sous forme JSON ({"score": 0.5, ...}) ou
 * texte avec "score: 0.7" embedded. Retourne null si pas extractible.
 */
export function parseRiskVerdictScore(content: string | null | undefined): number | null {
  if (!content) return null;
  // 1. Tentative JSON brut
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.score === 'number') {
      const s = parsed.score;
      if (s >= 0 && s <= 1) return s;
    }
  } catch { /* continue */ }

  // 2. Tentative JSON dans ```json fences
  const fence = content.match(/```(?:json|text)?\s*([\s\S]*?)\s*```/);
  if (fence) {
    try {
      const parsed = JSON.parse(fence[1].trim());
      if (typeof parsed?.score === 'number' && parsed.score >= 0 && parsed.score <= 1) {
        return parsed.score;
      }
    } catch { /* continue */ }
  }

  // 3. Tentative regex "score: 0.5" / "score":0.5
  const m = content.match(/["\s]?score["\s]?\s*[:=]\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const s = parseFloat(m[1]);
    if (s >= 0 && s <= 1) return s;
  }

  return null;
}
