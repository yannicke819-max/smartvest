/**
 * Blow-off / pump-fade detection gates — pure helpers (no I/O).
 *
 * Conçu suite au post-mortem OKLO.US (03/06/2026, -1.63% en 35min, top tick
 * exact $66.46). Le candidat avait persistence 5/5 et overallEfficiency=0.65
 * (OK), MAIS :
 *   - tf1h pathEff=0.28 (choppy) masqué par 5m=1.00 sur 2 ticks
 *   - tf30m=12.10%, tf5m=11.79% → plateau pré-burst (climax run)
 *   - ch1m=9.84% / tf5m=11.79% → 83% du move 5min concentré sur la dernière minute
 *
 * Les 3 gates ci-dessous capturent ces patterns. Pures fonctions sans I/O ni
 * dépendances, testables seules. Cf. tests dans __tests__/blow-off-gates.spec.ts
 *
 * Références (cf. lessons preamble #7-#28) :
 *   - O'Neil "climax run" : up 25%+ in 1-2 weeks after prior uptrend
 *   - Minervini "don't chase extended" : price > 10% above 20MA
 *   - Raschke "buy first pullback, not first push"
 *   - Bulkowski shooting star / blow-off top
 *   - Kamps-Kleinberg / La Morgia : real-time P&D detection
 */

export interface PathEffByTf {
  tf5m: { pathEfficiency: number } | null;
  tf10m: { pathEfficiency: number } | null;
  tf15m: { pathEfficiency: number } | null;
  tf30m: { pathEfficiency: number } | null;
  tf1h: { pathEfficiency: number } | null;
}

/**
 * Gate 1 — Path efficiency PAR TF (pas seulement overall).
 *
 * Le 1h et le 30m sont les vues structurelles (vrai trend), pas optique. Si
 * elles sont choppy mais overall est OK (tiré par 5m=1.00 sur 2 ticks), on
 * masque un setup en réalité chaotique. Cf. OKLO 03/06 : tf1h=0.28, overall=0.65.
 *
 * @returns null si pas de violation, sinon { tf, value } du TF fautif.
 */
export function evaluatePathEffLongTf(
  pathQuality: PathEffByTf | undefined | null,
  threshold: number | null | undefined,
): { tf: 'tf30m' | 'tf1h'; value: number } | null {
  if (threshold == null || !pathQuality) return null;
  const tf1hEff = pathQuality.tf1h?.pathEfficiency;
  const tf30mEff = pathQuality.tf30m?.pathEfficiency;
  if (tf1hEff != null && tf1hEff < threshold) return { tf: 'tf1h', value: tf1hEff };
  if (tf30mEff != null && tf30mEff < threshold) return { tf: 'tf30m', value: tf30mEff };
  return null;
}

/**
 * Gate 2 — Climax run / blow-off : plateau-then-burst.
 *
 * Signature : tf30m ≈ tf5m (∆ < 1.5pt) → flat entre H-30min et H-5min ago
 *             AND tf5m ≥ 5%             → move 5min substantiel
 * Conclusion : tout le move récent est concentré dans le dernier ~5min après
 * un long plateau. C'est le top tick par construction (mean reversion immédiate).
 *
 * OKLO 03/06 : tf5m=11.79%, tf30m=12.10%, ∆=0.31pt < 1.5 → CLIMAX_RUN.
 */
export function evaluateClimaxRun(
  tf5m: number | null | undefined,
  tf30m: number | null | undefined,
  options?: { minTf5mPct?: number; maxPlateauGapPct?: number },
): { tf5m: number; tf30m: number; gapPct: number } | null {
  const minMove = options?.minTf5mPct ?? 5;
  const maxGap = options?.maxPlateauGapPct ?? 1.5;
  if (tf5m == null || tf30m == null) return null;
  if (tf5m < minMove) return null;
  const gap = Math.abs(tf30m - tf5m);
  if (gap >= maxGap) return null;
  return { tf5m, tf30m, gapPct: gap };
}

/**
 * Gate 3 — Vertical pump : last-minute concentration.
 *
 * Signature : ch1m / tf5m > 0.5 AND tf5m ≥ 5%
 *   → plus de la moitié du move 5min s'est fait dans la dernière minute.
 *
 * Healthy momentum linéaire : ch1m ≈ tf5m / 5 (ratio ~0.2). Vertical pump :
 * ratio > 0.5 → late FOMO bar. Entrée à ce moment = top tick.
 *
 * OKLO 03/06 : ch1m=9.84% / tf5m=11.79% = 0.834 → VERTICAL_PUMP.
 */
export function evaluateVerticalPump(
  ch1m: number | null | undefined,
  tf5m: number | null | undefined,
  options?: { minTf5mPct?: number; maxRatio?: number },
): { ch1m: number; tf5m: number; ratio: number } | null {
  const minMove = options?.minTf5mPct ?? 5;
  const maxRatio = options?.maxRatio ?? 0.5;
  if (ch1m == null || tf5m == null) return null;
  if (!Number.isFinite(ch1m) || !Number.isFinite(tf5m)) return null;
  if (tf5m < minMove) return null;
  if (ch1m <= 0) return null;
  const ratio = ch1m / tf5m;
  if (ratio <= maxRatio) return null;
  return { ch1m, tf5m, ratio };
}

/**
 * Gate 4 — Top-tick drift à l'open.
 *
 * Si le live price au moment du fill a drifté UP de plus de `maxDriftPct` vs
 * le snapshot scanner (cand.close), le pump continue pendant l'éval gate
 * (5-15s LLM) et on est en train de buy le peak.
 *
 * OKLO 03/06 : cand.close=$66.35, quote.price=$66.46 → +0.166% drift = top tick.
 * Default seuil 0.25% — tunable via env GAINERS_TOP_TICK_DRIFT_MAX_PCT.
 *
 * Raschke "wait first pullback, not first push" — skip ce cycle, le candidat
 * reviendra peut-être après pullback (sinon mean reversion = bonne décision).
 */
export function evaluateTopTickDrift(
  livePrice: number,
  candClose: number | null | undefined,
  maxDriftPct: number,
): { driftPct: number; threshold: number } | null {
  if (candClose == null || !Number.isFinite(candClose) || candClose <= 0) return null;
  if (!Number.isFinite(livePrice) || livePrice <= 0) return null;
  if (!Number.isFinite(maxDriftPct) || maxDriftPct <= 0) return null;
  const driftPct = ((livePrice - candClose) / candClose) * 100;
  if (driftPct <= maxDriftPct) return null;
  return { driftPct, threshold: maxDriftPct };
}
