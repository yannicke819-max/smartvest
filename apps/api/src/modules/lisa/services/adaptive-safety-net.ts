/**
 * AdaptiveSafetyNet — backoff progressif du filet de garantie autopilot
 * quand le régime est stable, pour économiser les coûts API.
 *
 * Cf. PATCH 4 (PR#4 P1) — risk-04-adaptive-safetynet-budget.
 *
 * Logique :
 *   N stables consécutifs → étire le filet :
 *     0-1 stables   → baseMin (ex: 7 min)
 *     2-4 stables   → max(15, base × 2)   = ralentit légèrement
 *     5-9 stables   → max(30, base × 4)   = ralentit moyen
 *     10+ stables   → max(60, base × 8)   = ralentit fort
 *
 * Est considéré stable un cycle qui :
 *   - n'a généré aucune proposition (theses=[]) ET
 *   - n'a pas changé de regime
 *
 * Tout event matériel (`onEventDetected`) ou tout cycle productif
 * (`proposalsGenerated > 0`) ou tout changement de regime
 * (`regimeChanged = true`) RESET le compteur à 0.
 *
 * Stateful pure — pas de side-effect, juste un compteur. Testable en
 * isolation via `__tests__/autopilot-adaptive-safetynet.spec.ts`.
 */
export class AdaptiveSafetyNet {
  private consecutiveStableCycles = 0;

  /**
   * Calcule le filet effectif pour le prochain cycle, étiré en fonction
   * du nombre de cycles stables consécutifs.
   *
   * @param baseMin Filet de base en minutes (cf. config.autopilot_cycle_minutes)
   */
  nextSafetyNetMin(baseMin: number): number {
    const n = this.consecutiveStableCycles;
    if (n < 2) return baseMin;
    if (n < 5) return Math.min(15, baseMin * 2);
    if (n < 10) return Math.min(30, baseMin * 4);
    return Math.min(60, baseMin * 8);
  }

  /**
   * À appeler après un cycle Lisa terminé. Si rien n'a changé (pas de
   * thèses ouvertes ET regime inchangé), on incrémente le compteur.
   * Sinon, reset à 0.
   */
  onCycleCompleted(result: {
    proposalsGenerated: number;
    regimeChanged: boolean;
  }): void {
    if (result.proposalsGenerated > 0 || result.regimeChanged) {
      this.consecutiveStableCycles = 0;
    } else {
      this.consecutiveStableCycles += 1;
    }
  }

  /**
   * À appeler dès qu'un event matériel est détecté (VIX shift, news catalyst,
   * drawdown, prix tenu shift). Reset immédiat — on doit redevenir réactif.
   */
  onEventDetected(): void {
    this.consecutiveStableCycles = 0;
  }

  /** Snapshot pour debug / monitoring. */
  getStableCount(): number {
    return this.consecutiveStableCycles;
  }
}
