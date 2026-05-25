/**
 * AXEES T2-B — Capital Allocator dynamique.
 *
 * Vision AXEES :
 *
 *   "Le capital flotte entre stratégies selon leur StrategyHealth (T1-#3).
 *    Une stratégie en monitoring est réduite à 50%, une stratégie active
 *    avec sharpe > 1.5 est bumpée à 130%. Une stratégie en quarantine est
 *    à 0%. On n'arrose plus une stratégie qui sous-performe, on dope celle
 *    qui marche."
 *
 * Aujourd'hui chaque portfolio = 1 capital fixe partagé entre stratégies
 * sans aucune pondération par performance. Une stratégie défaillante mange
 * le même budget qu'une stratégie qui carbure.
 *
 * Cette couche définit :
 *   - StrategyAllocationInput : stratégie + StrategyHealth + baseAllocationPct
 *   - AllocationVerdict : pondération finale + reason + bornes appliquées
 *   - allocateCapital(inputs, rules?) : pure fn déterministe
 *
 * Règles immuables :
 *   1. Stratégies en `quarantine` ou `retired` -> 0% (jamais d'override).
 *   2. Stratégies en `monitoring` -> max 50% de base allocation.
 *   3. Stratégies en `proposed` -> max 10% de base (paper-only majoritaire).
 *   4. Stratégies en `active` :
 *      - sharpe >= 1.5 ET pnl7d >= 0 -> 1.3x base (boost performant)
 *      - sharpe in [0.5, 1.5[ -> 1.0x base (nominal)
 *      - sharpe < 0.5 OU pnl7d < 0 -> 0.7x base (sous-performant)
 *   5. Somme conservée : si total > 100% capital, on rescale proportionnellement.
 *   6. Borne plancher 5% par stratégie active (sinon trop fragmenté pour faire effet).
 *
 * Back-compat : ADDITIVE. Pas de wiring runtime — le caller (orchestrator
 * portfolio, cron de rebalance) applique les verdicts.
 */

import type { StrategyHealth, StrategyState } from './strategy-lifecycle';

export interface StrategyAllocationInput {
  /** Identifiant unique de la stratégie. */
  strategyId: string;
  /** État du cycle de vie (cf. T1-#3 strategy-lifecycle). */
  state: StrategyState;
  /** Métriques de santé courantes. */
  health: StrategyHealth;
  /**
   * Allocation de base en % du capital total (0..1). ex: 0.20 = 20% du capital.
   * Le scaler applique multipliers/cap dessus.
   */
  baseAllocationPct: number;
}

export interface CapitalAllocationRules {
  /** Plancher minimum pour une stratégie active (sinon trop fragmenté). */
  minActiveAllocationPct: number;
  /** Plafond max d'une seule stratégie (anti-concentration). */
  maxSingleAllocationPct: number;
  /** Multiplier sur baseAllocationPct pour stratégie active performante. */
  performantMultiplier: number;
  /** Multiplier sur baseAllocationPct pour stratégie active sous-performante. */
  underperformerMultiplier: number;
  /** Plafond pour stratégie en monitoring (fraction de baseAllocationPct). */
  monitoringCap: number;
  /** Plafond pour stratégie en proposed (paper-mostly). */
  proposedCap: number;
  /** Seuils sharpe pour classification active. */
  performantSharpeMin: number;
  underperformerSharpeMax: number;
}

export const DEFAULT_ALLOCATION_RULES: CapitalAllocationRules = {
  minActiveAllocationPct: 0.05,
  maxSingleAllocationPct: 0.40,
  performantMultiplier: 1.3,
  underperformerMultiplier: 0.7,
  monitoringCap: 0.5,
  proposedCap: 0.1,
  performantSharpeMin: 1.5,
  underperformerSharpeMax: 0.5,
};

export interface AllocationVerdict {
  strategyId: string;
  /** Allocation finale en fraction du capital (0..1). */
  finalAllocationPct: number;
  /** Allocation brute avant rescale (pour audit). */
  rawAllocationPct: number;
  /** Multiplier appliqué (1.0 = nominal). */
  appliedMultiplier: number;
  /** True si une borne (plancher, plafond, rescale) a été appliquée. */
  capped: boolean;
  reason: string;
}

export interface CapitalAllocationResult {
  verdicts: ReadonlyArray<AllocationVerdict>;
  /** Somme des allocations finales (devrait être <= 1.0). */
  totalAllocated: number;
  /** Cash résiduel non alloué (1.0 - totalAllocated). */
  residualCashPct: number;
  /** Stratégies forcées à 0% (quarantine/retired). */
  zeroedStrategies: ReadonlyArray<string>;
  /** True si rescale proportionnel a été appliqué. */
  rescaled: boolean;
}

/**
 * Calcule l'allocation par stratégie selon état + santé.
 *
 * Algorithme :
 *   1. Pour chaque stratégie, calcule raw allocation selon state + health
 *   2. Si state in {quarantine, retired} -> 0
 *   3. Si state = monitoring -> min(base, base × monitoringCap)
 *   4. Si state = proposed -> min(base, base × proposedCap)
 *   5. Si state = active :
 *      - performant -> base × performantMultiplier
 *      - underperformer -> base × underperformerMultiplier
 *      - autre -> base × 1.0
 *   6. Borne haute : min(raw, maxSingleAllocationPct)
 *   7. Borne basse : si state=active ET raw < minActiveAllocationPct -> 0
 *   8. Rescale : si sum(raw) > 1.0, scale proportionnellement
 *
 * Pure fn déterministe.
 */
export function allocateCapital(
  inputs: ReadonlyArray<StrategyAllocationInput>,
  rules: CapitalAllocationRules = DEFAULT_ALLOCATION_RULES,
): CapitalAllocationResult {
  const zeroed: string[] = [];
  const verdicts: Array<AllocationVerdict & { rawForRescale: number }> = [];

  for (const inp of inputs) {
    const v = computeSingle(inp, rules, zeroed);
    verdicts.push({ ...v, rawForRescale: v.finalAllocationPct });
  }

  // Rescale si somme > 1.0
  const rawSum = verdicts.reduce((acc, v) => acc + v.finalAllocationPct, 0);
  let rescaled = false;
  if (rawSum > 1.0) {
    rescaled = true;
    const scaleFactor = 1.0 / rawSum;
    for (const v of verdicts) {
      v.finalAllocationPct *= scaleFactor;
      if (!v.capped) v.capped = true;
      v.reason += ` Rescale x${scaleFactor.toFixed(3)} (somme initiale ${(rawSum * 100).toFixed(0)}% > 100%).`;
    }
  }

  const totalAllocated = verdicts.reduce((acc, v) => acc + v.finalAllocationPct, 0);
  const residualCashPct = Math.max(0, 1.0 - totalAllocated);

  return {
    verdicts: verdicts.map(({ rawForRescale: _ignored, ...v }) => v),
    totalAllocated,
    residualCashPct,
    zeroedStrategies: zeroed,
    rescaled,
  };
}

function computeSingle(
  inp: StrategyAllocationInput,
  rules: CapitalAllocationRules,
  zeroed: string[],
): AllocationVerdict {
  // 1. Quarantine / retired -> 0
  if (inp.state === 'quarantine' || inp.state === 'retired') {
    zeroed.push(inp.strategyId);
    return {
      strategyId: inp.strategyId,
      finalAllocationPct: 0,
      rawAllocationPct: 0,
      appliedMultiplier: 0,
      capped: true,
      reason: `State=${inp.state} : allocation forcée à 0.`,
    };
  }

  // 2. Monitoring -> cap
  if (inp.state === 'monitoring') {
    const raw = inp.baseAllocationPct * rules.monitoringCap;
    const final = Math.min(raw, rules.maxSingleAllocationPct);
    return {
      strategyId: inp.strategyId,
      finalAllocationPct: final,
      rawAllocationPct: raw,
      appliedMultiplier: rules.monitoringCap,
      capped: final < raw || raw < inp.baseAllocationPct,
      reason: `Monitoring : cap ${(rules.monitoringCap * 100).toFixed(0)}% (raw ${(raw * 100).toFixed(1)}%).`,
    };
  }

  // 3. Proposed -> cap bas
  if (inp.state === 'proposed') {
    const raw = inp.baseAllocationPct * rules.proposedCap;
    return {
      strategyId: inp.strategyId,
      finalAllocationPct: raw,
      rawAllocationPct: raw,
      appliedMultiplier: rules.proposedCap,
      capped: true,
      reason: `Proposed : cap ${(rules.proposedCap * 100).toFixed(0)}% (paper-mostly).`,
    };
  }

  // 4. Active -> multiplier selon perf
  const { sharpe, pnl7dPct } = inp.health;
  let multiplier = 1.0;
  let label = 'nominal';
  if (typeof sharpe === 'number' && sharpe >= rules.performantSharpeMin && (pnl7dPct ?? 0) >= 0) {
    multiplier = rules.performantMultiplier;
    label = 'performant';
  } else if (
    (typeof sharpe === 'number' && sharpe < rules.underperformerSharpeMax) ||
    (typeof pnl7dPct === 'number' && pnl7dPct < 0)
  ) {
    multiplier = rules.underperformerMultiplier;
    label = 'sous-performant';
  }

  const raw = inp.baseAllocationPct * multiplier;

  // 5. Borne basse : si trop petit, on zero
  if (raw < rules.minActiveAllocationPct) {
    zeroed.push(inp.strategyId);
    return {
      strategyId: inp.strategyId,
      finalAllocationPct: 0,
      rawAllocationPct: raw,
      appliedMultiplier: multiplier,
      capped: true,
      reason: `Active ${label} : ${(raw * 100).toFixed(1)}% < plancher ${(rules.minActiveAllocationPct * 100).toFixed(0)}% -> 0.`,
    };
  }

  // 6. Borne haute : cap maxSingle
  const final = Math.min(raw, rules.maxSingleAllocationPct);
  return {
    strategyId: inp.strategyId,
    finalAllocationPct: final,
    rawAllocationPct: raw,
    appliedMultiplier: multiplier,
    capped: final < raw,
    reason: `Active ${label} : multiplier ${multiplier} -> ${(final * 100).toFixed(1)}%.`,
  };
}
