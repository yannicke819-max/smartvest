/**
 * P2-C — Sizing dynamique selon régime risk-on / risk-off.
 *
 * Ajuste `targetDeploymentPct` (% capital cible déployé en positions actives,
 * le reste en cash reserve) en fonction de l'environnement macro.
 *
 *   RISK_ON  (VIX < 20  ET  spread us10y-us2y > 0)        → baseline + 5 pp
 *   RISK_OFF (VIX ≥ 20  ET  spread us10y-us2y ≤ 0)        → baseline − 20 pp
 *   NEUTRAL  (signaux mixtes ou inputs incomplets)         → no-op
 *
 * Symétrie volontaire conservatrice : on ne bascule en RISK_OFF que si
 * les DEUX signaux de stress sont présents (volatilité implicite haute
 * ET yield curve inversée). Sur signal mixte (VIX bas + curve inversée
 * OU VIX haut + curve steepening) on reste au baseline plutôt que de
 * scaler une décision sur un seul indicateur.
 *
 * Note : "DXY descendant" du backlog initial n'est pas implémenté —
 * MarketSnapshot n'expose qu'une valeur instantanée de DXY, sans delta
 * historique. Les deux critères retenus (vol implicite + slope yield
 * curve) sont les proxies les plus robustes du risk appetite.
 *
 * Pure function, testable sans I/O. Le caller substitue la valeur
 * retournée à `RiskConstraints.targetDeploymentPct` AVANT envoi prompt
 * Lisa.
 */

export interface RiskOnOffInputs {
  /** VIX index (volatilité implicite SP500 30j). null si snapshot dégradé. */
  vix: number | null;
  /** US 10-year Treasury yield (%). null si cascade échouée. */
  us10yYield: number | null;
  /** US 2-year Treasury yield (%). null si cascade échouée. */
  us2yYield: number | null;
}

export type RiskOnOffRegime = 'RISK_ON' | 'RISK_OFF' | 'NEUTRAL';

export interface DeploymentScaleVerdict {
  regime: RiskOnOffRegime;
  /** Raisons humaines (`vix=18.5<20`, `spread=42bps>0`…). */
  reasons: string[];
  /** Nouveau targetDeploymentPct après ajustement régime, clampé [0,100]. */
  adjustedDeploymentPct: number;
  /** Delta en points appliqué au baseline (+5 / -20 / 0). */
  deltaPct: number;
}

const VIX_CALM_THRESHOLD = 20;
const RISK_ON_BONUS_PCT = 5;
const RISK_OFF_PENALTY_PCT = -20;

export function computeRegimeAdjustedDeployment(
  inputs: RiskOnOffInputs,
  baselineDeploymentPct: number,
): DeploymentScaleVerdict {
  const baseline = clampPct(baselineDeploymentPct);

  // Inputs incomplets → on garde le baseline (NEUTRAL).
  const vix = isFiniteNumber(inputs.vix) ? (inputs.vix as number) : null;
  const us10y = isFiniteNumber(inputs.us10yYield) ? (inputs.us10yYield as number) : null;
  const us2y = isFiniteNumber(inputs.us2yYield) ? (inputs.us2yYield as number) : null;

  if (vix === null || us10y === null || us2y === null) {
    return {
      regime: 'NEUTRAL',
      reasons: ['inputs_incomplete'],
      adjustedDeploymentPct: baseline,
      deltaPct: 0,
    };
  }

  // spread en bps pour lisibilité (pp × 100). Steepening = spread > 0.
  const spreadBps = (us10y - us2y) * 100;
  const vixCalm = vix < VIX_CALM_THRESHOLD;
  const curveSteepening = spreadBps > 0;

  if (vixCalm && curveSteepening) {
    return {
      regime: 'RISK_ON',
      reasons: [
        `vix=${vix.toFixed(1)}<${VIX_CALM_THRESHOLD}`,
        `spread=${spreadBps.toFixed(0)}bps>0`,
      ],
      adjustedDeploymentPct: clampPct(baseline + RISK_ON_BONUS_PCT),
      deltaPct: RISK_ON_BONUS_PCT,
    };
  }

  if (!vixCalm && !curveSteepening) {
    return {
      regime: 'RISK_OFF',
      reasons: [
        `vix=${vix.toFixed(1)}>=${VIX_CALM_THRESHOLD}`,
        `spread=${spreadBps.toFixed(0)}bps<=0`,
      ],
      adjustedDeploymentPct: clampPct(baseline + RISK_OFF_PENALTY_PCT),
      deltaPct: RISK_OFF_PENALTY_PCT,
    };
  }

  // Signaux mixtes → NEUTRAL (no-op).
  return {
    regime: 'NEUTRAL',
    reasons: [
      vixCalm ? `vix=${vix.toFixed(1)}<${VIX_CALM_THRESHOLD}` : `vix=${vix.toFixed(1)}>=${VIX_CALM_THRESHOLD}`,
      curveSteepening ? `spread=${spreadBps.toFixed(0)}bps>0` : `spread=${spreadBps.toFixed(0)}bps<=0`,
    ],
    adjustedDeploymentPct: baseline,
    deltaPct: 0,
  };
}

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function isFiniteNumber(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}
