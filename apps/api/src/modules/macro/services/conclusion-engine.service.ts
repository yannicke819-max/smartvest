import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import type { SignalConclusion, ConclusionOutputMode, SignalImpactAssessment, HistoricalAnalog } from '@smartvest/domain';

const COUNTER_ARGUMENTS: Record<string, string[]> = {
  central_bank_decision: [
    'Les marchés ont peut-être déjà intégré cette décision (priced in).',
    'La communication prospective de la banque centrale peut atténuer l\'impact.',
    'Le cycle économique peut absorber le choc si la croissance reste solide.',
  ],
  geopolitical_tension: [
    'Les marchés résilients face aux chocs géopolitiques passés (effet de court terme).',
    'La géographie du conflit peut limiter l\'impact aux économies directement concernées.',
    'Des avancées diplomatiques restent possibles.',
  ],
  inflation_data: [
    'L\'inflation peut être transitoire si liée à des facteurs d\'offre temporaires.',
    'La banque centrale peut moduler son calendrier si la croissance ralentit.',
    'Les chiffres peuvent être révisés — un seul point de données ne fait pas tendance.',
  ],
  market_stress: [
    'Les banques centrales disposent de nombreux outils d\'intervention.',
    'Les fondamentaux macro peuvent rester solides malgré la volatilité de marché.',
    'Le stress peut créer des opportunités pour les investisseurs de long terme.',
  ],
  default: [
    'Les hypothèses d\'impact sont déterministes et ne capturent pas la complexité réelle.',
    'La diversification du portefeuille peut amortir l\'effet.',
    'L\'horizon d\'investissement modifie substantiellement la pertinence du signal.',
  ],
};

function selectOutputMode(
  severity: string,
  needsReview: boolean,
  hasPortfolioImpact: boolean,
): ConclusionOutputMode {
  if (severity === 'systemic' || severity === 'critical') return hasPortfolioImpact ? 'alert' : 'information';
  if (needsReview) return 'simulation';
  if (severity === 'warning') return 'information';
  return 'information';
}

function buildProbableScenario(category: string, severity: string): string {
  const templates: Record<string, string> = {
    central_bank_decision:
      'Ajustement du coût du capital avec répercussions sur les valorisations obligataires et actions de croissance. Impact immédiat sur les spreads de crédit.',
    inflation_data:
      'Révision des anticipations de politique monétaire. Pressions sur les marges des entreprises exposées aux intrants.',
    geopolitical_tension:
      'Fuite vers les valeurs refuges (dollar, or, obligations souveraines AAA). Hausse de la volatilité à court terme.',
    market_stress:
      'Désengagement général, hausse du VIX, élargissement des spreads de crédit. Risque de liquidité sur les actifs moins liquides.',
    fx_move:
      'Impact sur la compétitivité des entreprises exportatrices/importatrices et les revenus libellés en devises étrangères.',
    commodity_move:
      'Répercussion sur les coûts de production des industries utilisatrices et les marges des producteurs.',
    election_event:
      'Incertitude politique à court terme pouvant peser sur l\'investissement et la consommation. Impact sectoriel conditionnel aux résultats.',
    regulatory_change:
      'Coûts de conformité accrus pour les secteurs ciblés. Risque de litiges et d\'ajustements opérationnels.',
    default:
      'Impact incertain — nécessite suivi et analyse approfondie avant toute action.',
  };
  const base = templates[category] ?? templates.default;
  if (severity === 'critical' || severity === 'systemic') {
    return `[IMPACT ÉLEVÉ] ${base}`;
  }
  return base;
}

@Injectable()
export class ConclusionEngineService {
  generate(
    signalId: string,
    category: string,
    severity: string,
    confidence: string,
    assessment: SignalImpactAssessment | null,
    analogs: HistoricalAnalog[],
  ): SignalConclusion {
    const exposedSectors = assessment?.sectorExposures.map((s: { sector: string }) => s.sector) ?? [];
    const exposedAssets = assessment?.assetExposures
      .filter((a: { direction: string }) => a.direction !== 'neutral')
      .map((a: { ticker: string | null; isin: string | null; assetId: string | null }) => a.ticker ?? a.isin ?? a.assetId ?? 'unknown')
      .filter(Boolean) ?? [];

    const hasPortfolioImpact = (assessment?.portfolioImpacts.length ?? 0) > 0;
    const needsReview = severity === 'warning' || severity === 'critical' || severity === 'systemic';

    const counterArgs = [
      ...(COUNTER_ARGUMENTS[category] ?? COUNTER_ARGUMENTS.default),
      ...analogs.flatMap((a) => a.limitationsOfComparison).slice(0, 2),
      'Les performances passées ne préjugent pas des performances futures.',
    ];

    const proposedActions: string[] = [];
    if (needsReview) proposedActions.push('Relancer la simulation de portefeuille avec ce signal comme hypothèse de stress.');
    if (hasPortfolioImpact) proposedActions.push('Examiner les positions exposées identifiées et évaluer la dérive d\'allocation.');
    if (analogs.length > 0) proposedActions.push('Consulter les épisodes analogues pour contextualiser l\'amplitude probable.');
    proposedActions.push('Aucune action exécutée — validation utilisateur requise pour toute modification de portefeuille.');

    return {
      id: uuid(),
      signalId,
      summaryText: this.buildSummary(category, severity, confidence, exposedSectors.length, analogs.length),
      exposedAssets,
      exposedSectors,
      probableScenario: buildProbableScenario(category, severity),
      mainRisk: this.buildMainRisk(category, severity),
      counterArguments: counterArgs,
      overallConfidence: confidence as 'low' | 'medium' | 'high',
      needsReview,
      outputMode: selectOutputMode(severity, needsReview, hasPortfolioImpact),
      proposedActions,
      delegationMode: 'MANUAL_EXPLICIT',
      generatedAt: new Date().toISOString(),
    };
  }

  private buildSummary(
    category: string,
    severity: string,
    confidence: string,
    sectorCount: number,
    analogCount: number,
  ): string {
    return (
      `Signal de catégorie "${category}" (sévérité: ${severity}, confiance: ${confidence}). ` +
      `${sectorCount} secteur(s) potentiellement affecté(s). ` +
      `${analogCount} épisode(s) analogue(s) identifié(s). ` +
      `Cette analyse est fournie à titre informatif — elle ne constitue pas un conseil en investissement. ` +
      `Toute action requiert une validation explicite de l'utilisateur.`
    );
  }

  private buildMainRisk(category: string, severity: string): string {
    const risks: Record<string, string> = {
      central_bank_decision: 'Resserrement des conditions financières plus fort ou plus durable qu\'anticipé.',
      geopolitical_tension: 'Escalade du conflit dépassant le scenario de base et déclenchant un choc de liquidité.',
      market_stress: 'Contagion à d\'autres classes d\'actifs et effets de second tour (deleveraging forcé).',
      inflation_data: 'Inflation plus persistante forçant une politique monétaire plus restrictive.',
      fx_move: 'Dislocation des flux de capitaux et impact sur les revenus en devises étrangères.',
      commodity_move: 'Disruption prolongée des approvisionnements avec impact sur les coûts industriels.',
      default: 'Sous-estimation de l\'impact ou de la durée — nécessite un suivi actif.',
    };
    const base = risks[category] ?? risks.default;
    return severity === 'systemic' ? `[SYSTÉMIQUE] ${base}` : base;
  }
}
