/**
 * AXEES T1-#3 — Strategy lifecycle formel.
 *
 * Aujourd'hui une "stratégie" SmartVest (rebound-tp, top-gainers, harvest,
 * persistence-multi-tf, ...) est implicite : elle existe tant que son code
 * est wired et son flag activé. Pas de notion d'âge, de performance attendue
 * vs réalisée, de quarantine, de retrait formel.
 *
 * Conséquence observée : une stratégie qui décroche (PnL 7j < -3% par ex.)
 * continue de tourner et de proposer des trades jusqu'à intervention manuelle.
 *
 * Vision AXEES :
 *
 *   "Chaque stratégie a un cycle de vie formel : proposed → active →
 *    monitoring → quarantine → retired. Les transitions sont déclenchées
 *    par des règles objectives (sample size, hit rate, drawdown, sharpe).
 *    Une stratégie en quarantine émet QUARANTINE — le débat (T1-#1) la
 *    respecte automatiquement, plus besoin de retirer son code."
 *
 * Cette couche définit :
 *   - StrategyState : les 5 états du cycle de vie
 *   - StrategyHealth : métriques de santé (sample, hitRate, sharpe, pnl7d, ddPct)
 *   - StrategyLifecycleRules : seuils de transition configurables
 *   - evaluateLifecycle() : pure fn, déterministe, retourne nextState + reason
 *
 * Back-compat : ADDITIVE. Pas de table DB créée par ce PR (suit dans wiring).
 * Le caller (orchestrator futur, manual cli) instancie sa propre table.
 */

import type { TradingDecision } from './trading-decision';

/**
 * Les 5 états du cycle de vie d'une stratégie.
 *
 *   proposed  : R&D, jamais déployée — n'émet que des shadow signals.
 *   active    : production, autorisée à émettre des ordres exécutables.
 *   monitoring: sous surveillance (drawdown léger, sample trop faible) —
 *               réduit sa taille via REDUCE_SIZE, mais reste live.
 *   quarantine: gel total des ordres — émet uniquement QUARANTINE. Le
 *               débat T1-#1 respecte ce verdict immédiatement.
 *   retired   : sortie définitive — pas de signal du tout, code peut être
 *               supprimé sans risque, ou conservé pour comparaison historique.
 */
export type StrategyState = 'proposed' | 'active' | 'monitoring' | 'quarantine' | 'retired';

/**
 * Métriques de santé d'une stratégie sur une fenêtre rolling.
 *
 * Toutes les valeurs sont normalisées (ratios, pourcentages décimaux) pour
 * éviter les bugs d'unité (cf. CLAUDE.md sur composite score saturation).
 */
export interface StrategyHealth {
  /** Nombre de trades fermés sur la fenêtre d'évaluation. */
  sampleSize: number;
  /** Hit rate observé (0..1). undefined si sample insuffisant. */
  hitRate?: number;
  /** Sharpe ratio annualisé. undefined si sample insuffisant. */
  sharpe?: number;
  /** PnL 7 jours en pourcentage du capital (-0.05 = -5%). */
  pnl7dPct?: number;
  /** Drawdown courant en pourcentage du peak (0.03 = -3% du peak). */
  drawdownPct?: number;
  /** Age de la stratégie en jours depuis création. */
  ageDays: number;
  /** Optionnel : flag de violation grave (ex: stratégie a explosé un guard). */
  criticalViolation?: boolean;
}

/**
 * Seuils de transition configurables. Defaults conservateurs basés sur
 * l'observation des stratégies SmartVest actuelles.
 */
export interface StrategyLifecycleRules {
  /** Sample size minimum pour passer de proposed → active. */
  minSampleForActivation: number;
  /** Hit rate minimum pour activation. */
  minHitRateForActivation: number;
  /** PnL 7j seuil (négatif) qui pousse vers monitoring. */
  monitoringPnl7dThreshold: number;
  /** PnL 7j seuil (négatif) qui pousse vers quarantine. */
  quarantinePnl7dThreshold: number;
  /** Drawdown seuil qui pousse vers quarantine. */
  quarantineDrawdownThreshold: number;
  /** Hit rate seuil qui pousse vers retired (stratégie inviable). */
  retiredHitRateThreshold: number;
  /** Age min en jours avant qu'une stratégie monitoring puisse être réhabilitée. */
  rehabilitationCooldownDays: number;
}

export const DEFAULT_LIFECYCLE_RULES: StrategyLifecycleRules = {
  minSampleForActivation: 30,
  minHitRateForActivation: 0.45,
  monitoringPnl7dThreshold: -0.02,
  quarantinePnl7dThreshold: -0.05,
  quarantineDrawdownThreshold: 0.15,
  retiredHitRateThreshold: 0.30,
  rehabilitationCooldownDays: 7,
};

export interface LifecycleEvaluation {
  /** État cible après évaluation. */
  nextState: StrategyState;
  /** Transition vs current ? Si false, nextState === currentState. */
  changed: boolean;
  /** Raison de la transition (ou du maintien). */
  reason: string;
  /** Verdict TradingDecision suggéré pour les signaux émis par cette stratégie. */
  suggestedVerdict: TradingDecision;
}

/**
 * Évalue le prochain état d'une stratégie selon ses métriques de santé.
 *
 * Pure fn déterministe — testable sans I/O. Le caller (orchestrator,
 * cron de monitoring) est responsable de persister la transition et
 * d'émettre les signaux conséquents.
 *
 * Priorité des règles (plus restrictif gagne) :
 *   1. criticalViolation → quarantine immédiat
 *   2. retired : hitRate effondré (< retiredHitRateThreshold sur sample >= 50)
 *   3. quarantine : drawdown OR pnl7d franchit seuil bas
 *   4. monitoring : pnl7d négatif mais pas catastrophique
 *   5. active : sample suffisant + hitRate ok + métriques saines
 *   6. proposed : default si sample insuffisant
 *
 * Réhabilitation (monitoring → active) :
 *   - pnl7d redevient ≥ 0 ET age dans cet état ≥ rehabilitationCooldownDays
 *   - Pas de réhabilitation possible depuis quarantine ou retired (transition
 *     manuelle exigée par opérateur).
 */
export function evaluateLifecycle(
  currentState: StrategyState,
  health: StrategyHealth,
  rules: StrategyLifecycleRules = DEFAULT_LIFECYCLE_RULES,
): LifecycleEvaluation {
  // Règle 1 : violation critique → quarantine immédiat, peu importe l'état
  if (health.criticalViolation) {
    return verdict(currentState, 'quarantine', 'Violation critique : quarantine immédiat.', 'QUARANTINE');
  }

  // Règle 2 : retired (hitRate effondré sur sample significatif)
  if (
    health.sampleSize >= 50 &&
    typeof health.hitRate === 'number' &&
    health.hitRate < rules.retiredHitRateThreshold
  ) {
    return verdict(
      currentState,
      'retired',
      `Hit rate ${(health.hitRate * 100).toFixed(0)}% < seuil ${(rules.retiredHitRateThreshold * 100).toFixed(0)}% sur ${health.sampleSize} trades : stratégie inviable.`,
      'QUARANTINE',
    );
  }

  // Règle 3 : quarantine (drawdown OU pnl7d catastrophique)
  if (
    (typeof health.drawdownPct === 'number' && health.drawdownPct >= rules.quarantineDrawdownThreshold) ||
    (typeof health.pnl7dPct === 'number' && health.pnl7dPct <= rules.quarantinePnl7dThreshold)
  ) {
    const cause = (health.drawdownPct ?? 0) >= rules.quarantineDrawdownThreshold
      ? `Drawdown ${((health.drawdownPct ?? 0) * 100).toFixed(1)}% >= seuil ${(rules.quarantineDrawdownThreshold * 100).toFixed(0)}%`
      : `PnL 7j ${((health.pnl7dPct ?? 0) * 100).toFixed(1)}% <= seuil ${(rules.quarantinePnl7dThreshold * 100).toFixed(0)}%`;
    return verdict(currentState, 'quarantine', `${cause} : quarantine.`, 'QUARANTINE');
  }

  // Règle 4 : monitoring (pnl7d négatif léger)
  if (typeof health.pnl7dPct === 'number' && health.pnl7dPct <= rules.monitoringPnl7dThreshold) {
    return verdict(
      currentState,
      'monitoring',
      `PnL 7j ${(health.pnl7dPct * 100).toFixed(1)}% sous seuil monitoring ${(rules.monitoringPnl7dThreshold * 100).toFixed(0)}% : passage en monitoring (sizing réduit).`,
      'REDUCE_SIZE',
    );
  }

  // Règle 5 : réhabilitation monitoring → active
  if (currentState === 'monitoring') {
    if (
      typeof health.pnl7dPct === 'number' &&
      health.pnl7dPct >= 0 &&
      health.ageDays >= rules.rehabilitationCooldownDays
    ) {
      return verdict(currentState, 'active', 'PnL 7j redevient positif + cooldown réhabilitation atteint : retour active.', 'HOLD');
    }
    // Maintien en monitoring tant que conditions de retour pas remplies.
    return verdict(currentState, 'monitoring', 'Maintien en monitoring (cooldown réhabilitation non atteint ou pnl7d encore négatif).', 'REDUCE_SIZE');
  }

  // Règle 6 : activation depuis proposed
  if (currentState === 'proposed') {
    if (
      health.sampleSize >= rules.minSampleForActivation &&
      typeof health.hitRate === 'number' &&
      health.hitRate >= rules.minHitRateForActivation
    ) {
      return verdict(
        currentState,
        'active',
        `Sample ${health.sampleSize} >= ${rules.minSampleForActivation} et hitRate ${(health.hitRate * 100).toFixed(0)}% >= ${(rules.minHitRateForActivation * 100).toFixed(0)}% : activation autorisée.`,
        'HOLD',
      );
    }
    return verdict(currentState, 'proposed', `Sample ${health.sampleSize} ou hitRate insuffisant pour activation. Reste en shadow.`, 'PAPER_ONLY');
  }

  // Pas de transition depuis quarantine/retired (manuelle requise)
  if (currentState === 'quarantine') {
    return verdict(currentState, 'quarantine', 'Quarantine maintenue : réhabilitation manuelle requise.', 'QUARANTINE');
  }
  if (currentState === 'retired') {
    return verdict(currentState, 'retired', 'Stratégie retirée : aucune transition automatique possible.', 'QUARANTINE');
  }

  // Default : active reste active si rien ne déclenche
  return verdict(currentState, 'active', 'Métriques saines : reste active.', 'HOLD');
}

function verdict(
  current: StrategyState,
  next: StrategyState,
  reason: string,
  suggested: TradingDecision,
): LifecycleEvaluation {
  return {
    nextState: next,
    changed: next !== current,
    reason,
    suggestedVerdict: suggested,
  };
}
