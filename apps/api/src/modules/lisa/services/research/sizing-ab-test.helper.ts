/**
 * Sizing A/B Test — pure helpers (no I/O).
 *
 * Évalue à chaque candidat scanner ouvrant une position ce que feraient
 * 2 stratégies de sizing alternatives :
 *   - Bucket A — concentrated : peu de positions, gros notional
 *   - Bucket B — diversified  : beaucoup de positions, petit notional
 *
 * Baseline = config réelle du scanner (status quo).
 *
 * Logique : si le bucket a encore de la capacité (open positions <
 * max_positions), simule l'ouverture avec son notional. Sinon, log
 * 'shadow_capacity_full'. Pas de simulation de prix — on mirror le PnL
 * réel de la position en le scalant au notional du bucket lors du close.
 */

export type BucketName = 'A_concentrated' | 'B_diversified' | 'baseline';
export type ShadowDecision = 'shadow_opened' | 'shadow_capacity_full' | 'shadow_skipped';

export interface BucketConfig {
  name: BucketName;
  max_positions: number;
  notional_usd: number;
  enabled: boolean;
}

export interface SizingABConfig {
  enabled: boolean;
  bucket_a: BucketConfig;
  bucket_b: BucketConfig;
  bucket_baseline: BucketConfig;
}

const DEFAULT_BUCKET_A_MAX = 3;
const DEFAULT_BUCKET_A_NOTIONAL = 2800;
const DEFAULT_BUCKET_B_MAX = 12;
const DEFAULT_BUCKET_B_NOTIONAL = 700;
const DEFAULT_BASELINE_MAX = 5;
const DEFAULT_BASELINE_NOTIONAL = 787;

const SAFETY_MIN_NOTIONAL = 100;
const SAFETY_MAX_NOTIONAL = 10_000;
const SAFETY_MIN_POSITIONS = 1;
const SAFETY_MAX_POSITIONS = 20;

/**
 * Parse env vars vers la config A/B complète.
 * Defaults conservateurs : A=3×$2800, B=12×$700, baseline=5×$787.
 */
export function parseSizingABConfig(env: {
  SIZING_AB_TEST_ENABLED?: string | undefined;
  SIZING_AB_BUCKET_A_MAX_POS?: string | undefined;
  SIZING_AB_BUCKET_A_NOTIONAL?: string | undefined;
  SIZING_AB_BUCKET_B_MAX_POS?: string | undefined;
  SIZING_AB_BUCKET_B_NOTIONAL?: string | undefined;
  SIZING_AB_BASELINE_MAX_POS?: string | undefined;
  SIZING_AB_BASELINE_NOTIONAL?: string | undefined;
}): SizingABConfig {
  const enabled = (env.SIZING_AB_TEST_ENABLED ?? 'false').toLowerCase() === 'true';
  return {
    enabled,
    bucket_a: parseBucket(
      'A_concentrated',
      env.SIZING_AB_BUCKET_A_MAX_POS,
      env.SIZING_AB_BUCKET_A_NOTIONAL,
      DEFAULT_BUCKET_A_MAX,
      DEFAULT_BUCKET_A_NOTIONAL,
      enabled,
    ),
    bucket_b: parseBucket(
      'B_diversified',
      env.SIZING_AB_BUCKET_B_MAX_POS,
      env.SIZING_AB_BUCKET_B_NOTIONAL,
      DEFAULT_BUCKET_B_MAX,
      DEFAULT_BUCKET_B_NOTIONAL,
      enabled,
    ),
    bucket_baseline: parseBucket(
      'baseline',
      env.SIZING_AB_BASELINE_MAX_POS,
      env.SIZING_AB_BASELINE_NOTIONAL,
      DEFAULT_BASELINE_MAX,
      DEFAULT_BASELINE_NOTIONAL,
      enabled,
    ),
  };
}

function parseBucket(
  name: BucketName,
  maxPosRaw: string | undefined,
  notionalRaw: string | undefined,
  defaultMax: number,
  defaultNotional: number,
  enabled: boolean,
): BucketConfig {
  const maxN = Number.parseInt(maxPosRaw ?? '', 10);
  const notN = Number.parseFloat(notionalRaw ?? '');
  const max = Number.isFinite(maxN) && maxN >= SAFETY_MIN_POSITIONS && maxN <= SAFETY_MAX_POSITIONS
    ? maxN
    : defaultMax;
  const notional = Number.isFinite(notN) && notN >= SAFETY_MIN_NOTIONAL && notN <= SAFETY_MAX_NOTIONAL
    ? Math.round(notN * 100) / 100
    : defaultNotional;
  return { name, max_positions: max, notional_usd: notional, enabled };
}

/**
 * Décide ce que ferait un bucket donné face à un candidat.
 *
 * @param bucket Config du bucket
 * @param currentOpenInBucket Nombre de shadow positions actuellement ouvertes
 *                            pour ce bucket (read depuis DB par caller)
 */
export function decideBucketAction(
  bucket: BucketConfig,
  currentOpenInBucket: number,
): { decision: ShadowDecision; reason: string } {
  if (!bucket.enabled) {
    return { decision: 'shadow_skipped', reason: 'bucket_disabled' };
  }
  if (currentOpenInBucket >= bucket.max_positions) {
    return {
      decision: 'shadow_capacity_full',
      reason: `${currentOpenInBucket}/${bucket.max_positions} positions deja ouvertes`,
    };
  }
  return {
    decision: 'shadow_opened',
    reason: `slot ${currentOpenInBucket + 1}/${bucket.max_positions} dispo`,
  };
}

/**
 * Compute le PnL scaled au notional du bucket basé sur le pnl_pct réel.
 *
 * @param realPnlPct Le pnl_pct % observé sur la position réelle
 * @param bucketNotional Le notional du bucket (ex $2800)
 * @returns pnl_usd scaled
 */
export function scalePnlToBucket(realPnlPct: number, bucketNotional: number): number {
  // pnl_usd = notional × (pnl_pct / 100)
  return Math.round((bucketNotional * realPnlPct) / 100 * 100) / 100;
}

/**
 * Aggrege les stats par bucket sur une période donnée (pour le rapport).
 */
export interface BucketStats {
  bucket: BucketName;
  n_signals: number;
  n_opened: number;
  n_capacity_full: number;
  n_closed: number;
  sum_pnl_usd: number;
  mean_pnl_pct: number;
  win_rate_pct: number;
  capital_efficiency: number; // sum_pnl_usd / (max_positions × notional_usd)
}

export interface ShadowSignalRow {
  bucket: BucketName;
  decision: ShadowDecision;
  closed_at: string | null;
  realized_pnl_usd: number | null;
  realized_pnl_pct: number | null;
  notional_usd: number;
  max_positions: number;
}

export function aggregateBucketStats(rows: ShadowSignalRow[]): BucketStats[] {
  const groups = new Map<BucketName, ShadowSignalRow[]>();
  for (const r of rows) {
    const arr = groups.get(r.bucket) ?? [];
    arr.push(r);
    groups.set(r.bucket, arr);
  }
  const out: BucketStats[] = [];
  for (const [bucket, arr] of groups.entries()) {
    const opened = arr.filter((r) => r.decision === 'shadow_opened');
    const closed = opened.filter((r) => r.closed_at != null && r.realized_pnl_usd != null);
    const winners = closed.filter((r) => (r.realized_pnl_usd ?? 0) > 0);
    const sumPnl = closed.reduce((s, r) => s + (r.realized_pnl_usd ?? 0), 0);
    const meanPct = closed.length > 0
      ? closed.reduce((s, r) => s + (r.realized_pnl_pct ?? 0), 0) / closed.length
      : 0;
    const maxCapital = opened.length > 0
      ? opened[0].max_positions * opened[0].notional_usd
      : 0;
    out.push({
      bucket,
      n_signals: arr.length,
      n_opened: opened.length,
      n_capacity_full: arr.filter((r) => r.decision === 'shadow_capacity_full').length,
      n_closed: closed.length,
      sum_pnl_usd: Math.round(sumPnl * 100) / 100,
      mean_pnl_pct: Math.round(meanPct * 1000) / 1000,
      win_rate_pct: closed.length > 0
        ? Math.round((winners.length * 100) / closed.length)
        : 0,
      capital_efficiency: maxCapital > 0
        ? Math.round((sumPnl / maxCapital) * 10000) / 100
        : 0,
    });
  }
  return out.sort((a, b) => a.bucket.localeCompare(b.bucket));
}
