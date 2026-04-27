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
import type { AllocationProposal, ThemeTag } from '../types';

/**
 * PATCH 6 — Stats d'edge structurées passées au RiskEnforcer pour gating
 * du sizer par sample size. Calculées par
 * `LisaPerformanceAnalyticsService.getBucketStats(regime)` côté apps/api.
 *
 * Le RiskEnforcer applique `sizingMultiplier` à TOUTES les allocations du
 * cycle AVANT le check maxPositionSizePct. Une thèse à 10% sur un régime
 * à N=8 (confidence='none', multiplier=0.3) sort à 3% net.
 */
export type EdgeConfidence = 'none' | 'weak' | 'moderate' | 'confirmed';

export interface EdgeStats {
  /** Nombre de trades observés sur le bucket régime */
  n: number;
  /** Win rate empirique [0,1] */
  winRate: number;
  /** Return moyen empirique en % */
  avgReturn: number;
  /** Niveau de confiance dérivé de N */
  confidence: EdgeConfidence;
  /** Multiplicateur appliqué au pctCapital (0.3 / 0.6 / 0.85 / 1.0) */
  sizingMultiplier: number;
}

export interface EdgeGateOptions {
  stats: EdgeStats;
  /** Si true, rejette le cycle quand confidence='none' ou 'weak'.
   *  Défaut false : on shrink seulement, jamais de rejet. */
  requireConfirmedEdge?: boolean;
}

/**
 * PATCH 3 — Position légère pour les checks incrémentaux par classe + thème.
 * Utilisée par `canOpen()` qui valide une SEULE proposition contre un
 * portefeuille existant, sans nécessiter une AllocationProposal complète.
 */
export interface PositionLite {
  ticker: string;
  assetClass: string;
  sizeUsd: number;
  themes?: ThemeTag[];
}

export interface CanOpenOptions {
  capital: number;
  /** Pct par classe (0.28 = 28%) */
  maxAssetClassPct?: Record<string, number>;
  /** Pct par thème (0.40 = 40%) */
  maxThemePct?: Record<string, number>;
}

export interface CanOpenResult {
  ok: boolean;
  reason?: 'would_exceed_class_cap' | 'would_exceed_theme_cap' | 'invalid_capital';
  details?: {
    asset_class?: string;
    theme?: string;
    current_pct?: number;
    projected_pct?: number;
    cap_pct?: number;
  };
}

/**
 * PATCH 3 — Helper pur (sans état) qui valide UNE proposition individuelle
 * contre un portefeuille existant. Cap classe + cap thème vérifiés
 * incrémentalement (proposal serait-elle au-dessus du cap si ouverte ?).
 *
 * Utilisé par les caller incrémentaux (mechanical-trading.processPortfolio
 * Step 3 boucle, tests, futurs guards). Le RiskEnforcer.enforce() reste
 * le check global sur AllocationProposal complète.
 */
export function canOpen(
  proposal: PositionLite,
  positions: PositionLite[],
  options: CanOpenOptions,
): CanOpenResult {
  const { capital, maxAssetClassPct = {}, maxThemePct = {} } = options;
  if (capital <= 0) return { ok: false, reason: 'invalid_capital' };

  // Aggregate exposure par classe et par thème depuis les positions tenues.
  const classExposure: Record<string, number> = {};
  const themeExposure: Record<string, number> = {};
  for (const p of positions) {
    classExposure[p.assetClass] = (classExposure[p.assetClass] ?? 0) + p.sizeUsd;
    for (const t of p.themes ?? []) {
      themeExposure[t] = (themeExposure[t] ?? 0) + p.sizeUsd;
    }
  }

  // Check cap classe
  const classKey = proposal.assetClass;
  const classCap = maxAssetClassPct[classKey];
  if (classCap != null) {
    const currentClass = classExposure[classKey] ?? 0;
    const projectedClass = (currentClass + proposal.sizeUsd) / capital;
    if (projectedClass > classCap) {
      return {
        ok: false,
        reason: 'would_exceed_class_cap',
        details: {
          asset_class: classKey,
          current_pct: currentClass / capital,
          projected_pct: projectedClass,
          cap_pct: classCap,
        },
      };
    }
  }

  // Check cap thème (chaque thème de la proposal individuellement)
  for (const theme of proposal.themes ?? []) {
    const themeCap = maxThemePct[theme];
    if (themeCap == null) continue; // pas de cap pour ce thème → ok
    const currentTheme = themeExposure[theme] ?? 0;
    const projectedTheme = (currentTheme + proposal.sizeUsd) / capital;
    if (projectedTheme > themeCap) {
      return {
        ok: false,
        reason: 'would_exceed_theme_cap',
        details: {
          theme,
          current_pct: currentTheme / capital,
          projected_pct: projectedTheme,
          cap_pct: themeCap,
        },
      };
    }
  }

  return { ok: true };
}

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
   * @param existingExposureByThemePct Optionnel — exposition agrégée des
   *   positions déjà tenues par thème (PATCH 3). Captures la concentration
   *   thématique transverse aux classes d'actifs (GDX equity + SLV commo
   *   + RTX equity = 1 thème geopolitical_safehaven concentré).
   */
  enforce(
    proposal: AllocationProposal,
    existingExposureByAssetClassPct?: Record<string, number>,
    existingExposureByThemePct?: Record<string, number>,
    edgeGate?: EdgeGateOptions,
  ): RiskEnforcementResult {
    const violations: RiskEnforcementResult['violations'] = [];
    const constraints = proposal.constraints;

    // PATCH 6 — Edge confidence N-gating (avant tout autre check de size).
    //
    // Le sizer Lisa est aveugle au sample size : 8 trades sur un régime =
    // bruit statistique. On force un multiplier <1 tant que N est insuffisant.
    // Quand `requireConfirmedEdge=true`, on REJETTE le cycle entier sur les
    // régimes à confidence 'none'/'weak' au lieu de juste shrinker — utile
    // en mode autopilot strict où on préfère ne rien faire qu'extrapoler.
    let edgeAdjusted = proposal;
    if (edgeGate) {
      const { stats, requireConfirmedEdge } = edgeGate;
      const isWeak = stats.confidence === 'none' || stats.confidence === 'weak';

      if (requireConfirmedEdge && isWeak) {
        violations.push({
          code: 'EDGE_NOT_CONFIRMED',
          severity: 'critical',
          message: `Edge non confirmé sur ce régime (N=${stats.n}, confidence=${stats.confidence}). requireConfirmedEdge=true → cycle rejeté.`,
        });
        // Pas de shrink utile : on rejette en bas de la fonction (critical).
      } else if (stats.sizingMultiplier < 1.0) {
        // Shrink toutes les allocations + amountUsd ; recompute cashReserve.
        edgeAdjusted = this.applyEdgeShrink(proposal, stats);
      }
    }

    // 1. Sum des allocations <= 100% (sur la version potentiellement shrinkée)
    const totalAllocPct = edgeAdjusted.allocations.reduce(
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
    if (Math.abs(edgeAdjusted.cashReservePct - expectedCashReserve) > 0.5) {
      violations.push({
        code: 'CASH_RESERVE_MISMATCH',
        severity: 'warning',
        message: `Cash reserve stated ${edgeAdjusted.cashReservePct}% but implied ${expectedCashReserve}%`,
      });
    }

    // 3. Chaque position <= maxPositionSizePct (post-shrink edge)
    for (const alloc of edgeAdjusted.allocations) {
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
    if (edgeAdjusted.allocations.length > constraints.maxOpenPositions) {
      violations.push({
        code: 'TOO_MANY_POSITIONS',
        severity: 'error',
        message: `${edgeAdjusted.allocations.length} positions proposed > max ${constraints.maxOpenPositions}`,
      });
    }

    // 5. Exposition par classe d'actifs <= maxExposurePerAssetClassPct
    // Agrégat = positions déjà tenues + nouvelles allocations du cycle.
    // Sans agrégat existant, on ne voit que les nouvelles allocations
    // → cycle 1 ouvre GDX 22%, cycle 2 ouvre SLV 18%, ni l'un ni l'autre
    // ne dépasse 28% individuellement mais cumul = 40% → bug 26/04.
    const newAllocByClass = this.aggregateByAssetClass(edgeAdjusted);
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

    // 5 bis. PATCH 3 — Plafonds par thème transverses aux classes d'actifs.
    // Cap par thème agit en plus du cap par classe : la position est rejetée
    // si l'un des deux casse. Capture la concentration thématique (GDX
    // equity + SLV commodity + RTX equity = 3 classes mais 1 thème
    // geopolitical_safehaven concentré).
    const newAllocByTheme = this.aggregateByTheme(edgeAdjusted);
    const exposureByTheme: Record<string, number> = { ...newAllocByTheme };
    if (existingExposureByThemePct) {
      for (const [theme, pct] of Object.entries(existingExposureByThemePct)) {
        exposureByTheme[theme] = (exposureByTheme[theme] ?? 0) + pct;
      }
    }
    const themeCaps = constraints.maxThemePct ?? {};
    for (const [theme, pct] of Object.entries(exposureByTheme)) {
      const cap = themeCaps[theme as keyof typeof themeCaps];
      if (cap == null) continue; // pas de cap défini pour ce thème → illimité
      if (pct > cap) {
        const existingPct = existingExposureByThemePct?.[theme] ?? 0;
        const newPct = newAllocByTheme[theme] ?? 0;
        violations.push({
          code: 'THEME_CONCENTRATION',
          severity: 'error',
          message: existingPct > 0
            ? `theme ${theme} total ${pct.toFixed(1)}% (tenu ${existingPct.toFixed(1)}% + nouveau ${newPct.toFixed(1)}%) exceeds max ${cap}%`
            : `theme ${theme} total ${pct.toFixed(1)}% exceeds max ${cap}%`,
        });
      }
    }

    // 6. Levier effectif portfolio (somme |sizingValue| leveraged expressions)
    const effectiveLeverage = this.computeEffectiveLeverage(edgeAdjusted);
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
    const estimatedVol = this.estimatePortfolioVolatility(edgeAdjusted);
    if (estimatedVol > constraints.maxPortfolioVolatilityPct) {
      violations.push({
        code: 'PORTFOLIO_VOLATILITY_EXCEEDED',
        severity: 'warning',
        message: `Estimated portfolio vol ${estimatedVol.toFixed(1)}% > max ${constraints.maxPortfolioVolatilityPct}%`,
      });
    }

    // 8. Coût total d'exécution raisonnable (warning si > 2% du capital)
    const totalExecutionCostBps = this.estimateTotalExecutionCost(edgeAdjusted);
    if (totalExecutionCostBps > 200) {
      violations.push({
        code: 'EXECUTION_COST_HIGH',
        severity: 'warning',
        message: `Total execution cost ~${totalExecutionCostBps}bps (>2% capital). Review expressions.`,
      });
    }

    // 9. Chaque thèse a expressions + invalidation + antiBullshit
    for (const thesis of edgeAdjusted.theses) {
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

    let adjustedProposal: AllocationProposal | null = edgeAdjusted;

    // Critique = REJET total
    if (criticalViolations.length > 0) {
      adjustedProposal = null;
    }
    // Erreur = tentative d'auto-correction (drop des thèses fautives, scale back)
    else if (errorViolations.length > 0) {
      adjustedProposal = this.autoCorrect(edgeAdjusted, violations);
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

  /**
   * PATCH 3 — Agrège l'allocation par thème.
   * Une thèse peut être taguée 1-2 thèmes ; chaque thème reçoit l'intégralité
   * du pctCapital de l'allocation (pas de division). C'est intentionnel :
   * une position GDX taguée [geopolitical_safehaven, energy_disruption]
   * compte 100% sur chacun des deux thèmes — le but est d'identifier la
   * concentration de risque.
   */
  private aggregateByTheme(proposal: AllocationProposal): Record<string, number> {
    const agg: Record<string, number> = {};
    for (const alloc of proposal.allocations) {
      const thesis = proposal.theses.find((t) => t.id === alloc.thesisId);
      if (!thesis) continue;
      const themes = thesis.themes ?? [];
      for (const theme of themes) {
        agg[theme] = (agg[theme] ?? 0) + alloc.pctCapital;
      }
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
   * PATCH 6 — Applique le sizingMultiplier (edge confidence) à toutes les
   * allocations du cycle. Mutation pure : retourne une nouvelle proposal
   * avec pctCapital + amountUsd shrinkés et cashReservePct recompute.
   *
   * Le multiplier est < 1 quand le bucket régime a un sample trop petit
   * (N<30). Une thèse à 10% sur un régime à N=8 (multiplier=0.3) sort à 3%.
   * Cash reserve récupère la différence.
   */
  private applyEdgeShrink(
    proposal: AllocationProposal,
    stats: EdgeStats,
  ): AllocationProposal {
    const m = stats.sizingMultiplier;
    if (m >= 1.0) return proposal;

    const shrunkAllocations = proposal.allocations.map((alloc) => {
      const newPct = alloc.pctCapital * m;
      const newAmountUsd = new Decimal(alloc.amountUsd).mul(m).toFixed(2);
      return { ...alloc, pctCapital: newPct, amountUsd: newAmountUsd };
    });

    const totalAllocPct = shrunkAllocations.reduce((s, a) => s + a.pctCapital, 0);
    const cashReservePct = Math.max(0, Math.min(100, 100 - totalAllocPct));

    return {
      ...proposal,
      allocations: shrunkAllocations,
      cashReservePct,
      warnings: [
        ...proposal.warnings,
        `Edge N-gating : sizingMultiplier=${m} (N=${stats.n}, confidence=${stats.confidence}) — toutes les allocations shrinkées de ×${m}.`,
      ],
    };
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
