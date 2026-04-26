/**
 * RiskEnforcer — Valide qu'une AllocationProposal respecte les HARD LIMITS.
 *
 * Ces contraintes sont le FILET DE SÉCURITÉ structurel. Elles ne font pas
 * confiance à Claude : même si Claude propose une allocation qui viole les
 * caps, le RiskEnforcer REFUSE ou AJUSTE la proposition avant qu'elle ne
 * soit présentée à l'utilisateur (ou auto-exécutée en autopilot).
 *
 * C'est l'équivalent du "circuit breaker" — une assurance que même un LLM
 * qui hallucine ne peut pas vider les 10k€ virtuels en une proposition folle.
 */

import Decimal from 'decimal.js';
import type { AllocationProposal } from '../types';

export interface RiskEnforcementResult {
  /** True si la proposition passe toutes les contraintes */
  passes: boolean;
  /** Violations détectées */
  violations: Array<{
    code: string;
    severity: 'warning' | 'error' | 'critical';
    message: string;
    affectedThesisId?: string;
  }>;
  /** Proposition ajustée (si auto-correction possible) ou null si rejet */
  adjustedProposal: AllocationProposal | null;
  /** Résumé humain lisible */
  summary: string;
}

export class RiskEnforcer {
  /**
   * Valide une proposition contre les contraintes.
  /**
   * Vérifie + ajuste une proposition.
   * Retourne la proposition inchangée si conforme, ajustée ou null sinon.
   *
   * @param proposal Proposition à vérifier
   * @param existingExposureByAssetClassPct Optionnel — exposition agrégée
   *   des positions déjà tenues par classe d'actifs. Permet au check
   *   ASSET_CLASS_CONCENTRATION de prendre en compte le portefeuille
   *   existant + les nouvelles allocations (incident 26/04 : précieux à
   *   40% sur 2 ouvertures successives chacune <28% mais agrégat ignoré).
   */
  enforce(
    proposal: AllocationProposal,
    existingExposureByAssetClassPct?: Record<string, number>,
  ): RiskEnforcementResult {
    const violations: RiskEnforcementResult['violations'] = [];
    const constraints = proposal.constraints;

    // 1. Sum des allocations <= 100%
    const totalAllocPct = proposal.allocations.reduce(
      (sum, a) => sum + a.pctCapital,
      0,
    );
    if (totalAllocPct > 100) {
      violations.push({
        code: 'ALLOCATIONS_EXCEED_100',
        severity: 'critical',
        message: `Sum of allocations = ${totalAllocPct}% > 100%. Cannot execute.`,
      });
    }

    // 2. Cash reserve cohérent
    const expectedCashReserve = 100 - totalAllocPct;
    if (Math.abs(proposal.cashReservePct - expectedCashReserve) > 0.5) {
      violations.push({
        code: 'CASH_RESERVE_MISMATCH',
        severity: 'warning',
        message: `Cash reserve stated ${proposal.cashReservePct}% but implied ${expectedCashReserve}%`,
      });
    }

    // 3. Chaque position <= maxPositionSizePct
    for (const alloc of proposal.allocations) {
      if (alloc.pctCapital > constraints.maxPositionSizePct) {
        violations.push({
          code: 'POSITION_SIZE_EXCEEDED',
          severity: 'error',
          message: `Position ${alloc.thesisId} at ${alloc.pctCapital}% exceeds max ${constraints.maxPositionSizePct}%`,
          affectedThesisId: alloc.thesisId,
        });
      }
    }

    // 4. Nombre de positions <= maxOpenPositions
    if (proposal.allocations.length > constraints.maxOpenPositions) {
      violations.push({
        code: 'TOO_MANY_POSITIONS',
        severity: 'error',
        message: `${proposal.allocations.length} positions proposed > max ${constraints.maxOpenPositions}`,
      });
    }

    // 5. Exposition par classe d'actifs <= maxExposurePerAssetClassPct
    // Agrégat = positions déjà tenues + nouvelles allocations du cycle.
    // Sans agrégat existant, on ne voit que les nouvelles allocations
    // → cycle 1 ouvre GDX 22%, cycle 2 ouvre SLV 18%, ni l'un ni l'autre
    // ne dépasse 28% individuellement mais cumul = 40% → bug 26/04.
    const newAllocByClass = this.aggregateByAssetClass(proposal);
    const exposureByAssetClass: Record<string, number> = { ...newAllocByClass };
    if (existingExposureByAssetClassPct) {
      for (const [cls, pct] of Object.entries(existingExposureByAssetClassPct)) {
        exposureByAssetClass[cls] = (exposureByAssetClass[cls] ?? 0) + pct;
      }
    }
    for (const [assetClass, pct] of Object.entries(exposureByAssetClass)) {
      if (pct > constraints.maxExposurePerAssetClassPct) {
        const existingPct = existingExposureByAssetClassPct?.[assetClass] ?? 0;
        const newPct = newAllocByClass[assetClass] ?? 0;
        violations.push({
          code: 'ASSET_CLASS_CONCENTRATION',
          severity: 'error',
          message: existingPct > 0
            ? `${assetClass} total ${pct.toFixed(1)}% (tenu ${existingPct.toFixed(1)}% + nouveau ${newPct.toFixed(1)}%) exceeds max ${constraints.maxExposurePerAssetClassPct}%`
            : `${assetClass} total ${pct.toFixed(1)}% exceeds max ${constraints.maxExposurePerAssetClassPct}%`,
        });
      }
    }

    // 6. Levier effectif portfolio (somme |sizingValue| leveraged expressions)
    const effectiveLeverage = this.computeEffectiveLeverage(proposal);
    if (effectiveLeverage > constraints.maxLeverage) {
      violations.push({
        code: 'LEVERAGE_EXCEEDED',
        severity: 'critical',
        message: `Effective leverage ${effectiveLeverage.toFixed(2)}x > max ${constraints.maxLeverage}x`,
      });
    }

    // 7. Volatilité portfolio estimée <= maxPortfolioVolatilityPct
    // (approximation : moyenne pondérée des vols individuelles — sous-estime
    // sans matrice de corrélation, mais donne un floor)
    const estimatedVol = this.estimatePortfolioVolatility(proposal);
    if (estimatedVol > constraints.maxPortfolioVolatilityPct) {
      violations.push({
        code: 'PORTFOLIO_VOLATILITY_EXCEEDED',
        severity: 'warning',
        message: `Estimated portfolio vol ${estimatedVol.toFixed(1)}% > max ${constraints.maxPortfolioVolatilityPct}%`,
      });
    }

    // 8. Coût total d'exécution raisonnable (warning si > 2% du capital)
    const totalExecutionCostBps = this.estimateTotalExecutionCost(proposal);
    if (totalExecutionCostBps > 200) {
      violations.push({
        code: 'EXECUTION_COST_HIGH',
        severity: 'warning',
        message: `Total execution cost ~${totalExecutionCostBps}bps (>2% capital). Review expressions.`,
      });
    }

    // 9. Chaque thèse a expressions + invalidation + antiBullshit
    for (const thesis of proposal.theses) {
      if (thesis.expressions.length === 0) {
        violations.push({
          code: 'THESIS_NO_EXPRESSIONS',
          severity: 'error',
          message: `Thesis "${thesis.title}" has no expressions`,
          affectedThesisId: thesis.id,
        });
      }
      if (thesis.invalidation.conditions.length === 0 && thesis.invalidation.qualitativeConditions.length === 0) {
        violations.push({
          code: 'THESIS_NO_INVALIDATION',
          severity: 'error',
          message: `Thesis "${thesis.title}" has no invalidation conditions — REJECTED`,
          affectedThesisId: thesis.id,
        });
      }
    }

    // Decide pass/fail + adjustments
    const criticalViolations = violations.filter((v) => v.severity === 'critical');
    const errorViolations = violations.filter((v) => v.severity === 'error');

    let adjustedProposal: AllocationProposal | null = proposal;

    // Critique = REJET total
    if (criticalViolations.length > 0) {
      adjustedProposal = null;
    }
    // Erreur = tentative d'auto-correction (drop des thèses fautives, scale back)
    else if (errorViolations.length > 0) {
      adjustedProposal = this.autoCorrect(proposal, violations);
    }

    const passes = violations.filter((v) => v.severity !== 'warning').length === 0;

    return {
      passes,
      violations,
      adjustedProposal,
      summary: this.buildSummary(passes, violations, adjustedProposal),
    };
  }

  private aggregateByAssetClass(proposal: AllocationProposal): Record<string, number> {
    const agg: Record<string, number> = {};
    for (const alloc of proposal.allocations) {
      const thesis = proposal.theses.find((t) => t.id === alloc.thesisId);
      if (!thesis) continue;
      const preferredExpr = thesis.expressions[thesis.preferredExpressionIndex];
      if (!preferredExpr) continue;
      agg[preferredExpr.assetClass] = (agg[preferredExpr.assetClass] ?? 0) + alloc.pctCapital;
    }
    return agg;
  }

  private computeEffectiveLeverage(proposal: AllocationProposal): number {
    let totalNotional = new Decimal(0);
    const capital = new Decimal(proposal.capitalUsd);

    for (const alloc of proposal.allocations) {
      const thesis = proposal.theses.find((t) => t.id === alloc.thesisId);
      if (!thesis) continue;
      const expr = thesis.expressions[thesis.preferredExpressionIndex];
      if (!expr) continue;

      // Pour options et dérivés, notional peut être > allocation
      // Ici simplifié : notional = amountUsd (pas de multiplier dérivés)
      totalNotional = totalNotional.plus(new Decimal(alloc.amountUsd));
    }

    if (capital.isZero()) return 0;
    return totalNotional.dividedBy(capital).toNumber();
  }

  private estimatePortfolioVolatility(proposal: AllocationProposal): number {
    // Approximation rough : agrégation pondérée des vols par asset class
    // (ignore corrélations — sous-estime ; un calcul réel nécessite matrice cov)
    const assetClassVolEstimates: Record<string, number> = {
      equity_us_large: 15,
      equity_us_small: 22,
      equity_eu: 17,
      equity_em: 22,
      govt_bonds_us: 5,
      credit_ig: 6,
      credit_hy: 10,
      fx_g10: 7,
      fx_em: 14,
      commodities_energy: 35,
      commodities_metals_precious: 18,
      crypto_bitcoin: 55,
      crypto_ethereum: 75,
      crypto_altcoins: 95,
      cash: 0,
    };

    let weightedVol = 0;
    for (const alloc of proposal.allocations) {
      const thesis = proposal.theses.find((t) => t.id === alloc.thesisId);
      if (!thesis) continue;
      const expr = thesis.expressions[thesis.preferredExpressionIndex];
      if (!expr) continue;
      const vol = assetClassVolEstimates[expr.assetClass] ?? 20;
      weightedVol += (alloc.pctCapital / 100) * vol;
    }
    return weightedVol;
  }

  private estimateTotalExecutionCost(proposal: AllocationProposal): number {
    let totalCost = 0;
    for (const alloc of proposal.allocations) {
      const thesis = proposal.theses.find((t) => t.id === alloc.thesisId);
      if (!thesis) continue;
      const expr = thesis.expressions[thesis.preferredExpressionIndex];
      if (!expr) continue;
      totalCost += (alloc.pctCapital / 100) * expr.estimatedCostBps;
    }
    return totalCost;
  }

  /**
   * Auto-correction : drop les thèses qui violent les contraintes,
   * re-allocate le cash restant.
   */
  private autoCorrect(
    proposal: AllocationProposal,
    violations: RiskEnforcementResult['violations'],
  ): AllocationProposal {
    const invalidThesisIds = new Set(
      violations
        .filter((v) => v.affectedThesisId && v.severity === 'error')
        .map((v) => v.affectedThesisId as string),
    );

    const validTheses = proposal.theses.filter((t) => !invalidThesisIds.has(t.id));
    const validAllocations = proposal.allocations.filter(
      (a) => !invalidThesisIds.has(a.thesisId),
    );

    // Recompute cash reserve
    const totalAllocPct = validAllocations.reduce((s, a) => s + a.pctCapital, 0);
    const cashReservePct = 100 - totalAllocPct;

    return {
      ...proposal,
      theses: validTheses,
      allocations: validAllocations,
      cashReservePct,
      warnings: [
        ...proposal.warnings,
        `Auto-corrected: dropped ${invalidThesisIds.size} thesis/theses violating risk constraints`,
      ],
    };
  }

  private buildSummary(
    passes: boolean,
    violations: RiskEnforcementResult['violations'],
    adjusted: AllocationProposal | null,
  ): string {
    if (passes && violations.length === 0) {
      return 'All risk constraints passed. Proposal ready for user review or auto-execution.';
    }
    if (passes && violations.length > 0) {
      return `Proposal passes with ${violations.length} warning(s). Review warnings before approval.`;
    }
    if (adjusted === null) {
      return `Proposal REJECTED (critical violations): ${violations.filter((v) => v.severity === 'critical').map((v) => v.code).join(', ')}`;
    }
    return `Proposal auto-corrected: ${violations.filter((v) => v.severity === 'error').length} thesis/theses dropped.`;
  }
}
