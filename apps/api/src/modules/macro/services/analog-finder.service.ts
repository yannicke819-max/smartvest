import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import type { HistoricalAnalog, RetexInsight } from '@smartvest/domain';

// Curated historical episode library — deterministic knowledge base
const EPISODE_LIBRARY: Omit<HistoricalAnalog, 'id' | 'signalId' | 'createdAt'>[] = [
  {
    episodeTitle: 'Fed pivot hawkish 2022',
    episodeDateStart: '2022-01-01',
    episodeDateEnd: '2022-12-31',
    contextDescription: 'La Fed a procédé à la série de hausses de taux la plus rapide depuis les années 1980 pour contrer une inflation post-COVID supérieure à 8%.',
    similarityScore: 0,
    keyDrivers: ['inflation_data', 'central_bank_decision'],
    resolution: 'Marchés actions en baisse de ~20%, obligations sous pression, dollar fort.',
    assetClassBehaviors: [
      { assetClass: 'equity', avgReturnPct: '-19.0', minReturnPct: '-35.0', maxReturnPct: '-5.0', medianDurationDays: 280, dispersionNote: 'Tech en pointe de la baisse (-40%)' },
      { assetClass: 'bonds', avgReturnPct: '-13.0', minReturnPct: '-18.0', maxReturnPct: '-8.0', medianDurationDays: 365, dispersionNote: null },
      { assetClass: 'commodities', avgReturnPct: '+12.0', minReturnPct: '0.0', maxReturnPct: '+40.0', medianDurationDays: 120, dispersionNote: 'Énergie en forte hausse S1' },
    ],
    limitationsOfComparison: [
      'Chaque cycle de hausse a un contexte structurel différent.',
      'La composition du portefeuille actuel peut différer significativement.',
    ],
  },
  {
    episodeTitle: 'Crise financière mondiale 2008–2009',
    episodeDateStart: '2008-09-01',
    episodeDateEnd: '2009-03-31',
    contextDescription: 'Effondrement du système bancaire mondial à la suite de la crise des subprimes. Panique de liquidité mondiale.',
    similarityScore: 0,
    keyDrivers: ['market_stress', 'credit_event'],
    resolution: 'S&P 500 -57% de pic à creux. Rebond vigoureux à partir de mars 2009.',
    assetClassBehaviors: [
      { assetClass: 'equity', avgReturnPct: '-40.0', minReturnPct: '-57.0', maxReturnPct: '-20.0', medianDurationDays: 180, dispersionNote: 'Financières les plus touchées' },
      { assetClass: 'government_bonds', avgReturnPct: '+12.0', minReturnPct: '+5.0', maxReturnPct: '+20.0', medianDurationDays: 180, dispersionNote: 'Valeur refuge' },
      { assetClass: 'gold', avgReturnPct: '+5.0', minReturnPct: '-15.0', maxReturnPct: '+25.0', medianDurationDays: 90, dispersionNote: 'Volatilité élevée, valeur refuge progressive' },
    ],
    limitationsOfComparison: [
      'Episode extrême — peu de crises comparables en ampleur.',
      'Interventions de banques centrales massives — contexte réglementaire différent.',
    ],
  },
  {
    episodeTitle: 'Invasion russe de l\'Ukraine 2022',
    episodeDateStart: '2022-02-24',
    episodeDateEnd: '2022-06-30',
    contextDescription: 'Déclenchement d\'un conflit armé majeur en Europe, entraînant des sanctions massives et une crise énergétique.',
    similarityScore: 0,
    keyDrivers: ['geopolitical_tension', 'commodity_move'],
    resolution: 'Pétrole +40%, gaz européen +200%, marchés actions -15% puis stabilisation.',
    assetClassBehaviors: [
      { assetClass: 'energy', avgReturnPct: '+35.0', minReturnPct: '+10.0', maxReturnPct: '+60.0', medianDurationDays: 60, dispersionNote: 'Gaz naturel européen exceptionnel' },
      { assetClass: 'equity', avgReturnPct: '-12.0', minReturnPct: '-20.0', maxReturnPct: '-5.0', medianDurationDays: 40, dispersionNote: 'Récupération partielle après 6 semaines' },
      { assetClass: 'gold', avgReturnPct: '+8.0', minReturnPct: '+2.0', maxReturnPct: '+15.0', medianDurationDays: 30, dispersionNote: null },
    ],
    limitationsOfComparison: [
      'Dépend fortement de la dépendance énergétique du portefeuille.',
      'Durée du conflit très incertaine.',
    ],
  },
  {
    episodeTitle: 'Covid-19 crash initial mars 2020',
    episodeDateStart: '2020-02-20',
    episodeDateEnd: '2020-04-01',
    contextDescription: 'Effondrement brutal des marchés suite à la pandémie mondiale — incertitude extrême et fermetures économiques.',
    similarityScore: 0,
    keyDrivers: ['market_stress', 'geopolitical_tension'],
    resolution: 'Krach de 34% en 33 jours, suivi du rebond le plus rapide de l\'histoire.',
    assetClassBehaviors: [
      { assetClass: 'equity', avgReturnPct: '-34.0', minReturnPct: '-40.0', maxReturnPct: '-25.0', medianDurationDays: 33, dispersionNote: 'Voyage, hôtellerie, énergie les plus touchés' },
      { assetClass: 'government_bonds', avgReturnPct: '+4.0', minReturnPct: '-2.0', maxReturnPct: '+10.0', medianDurationDays: 33, dispersionNote: 'Bons du Trésor US valeur refuge' },
      { assetClass: 'gold', avgReturnPct: '+3.0', minReturnPct: '-8.0', maxReturnPct: '+15.0', medianDurationDays: 33, dispersionNote: 'Volatilité inhabituelle — chocs de liquidité' },
    ],
    limitationsOfComparison: [
      'Choc exogène et imprévisible par nature.',
      'Réponse fiscale et monétaire sans précédent a accéléré la reprise.',
    ],
  },
];

const CATEGORY_TO_EPISODES: Record<string, string[]> = {
  central_bank_decision: ['Fed pivot hawkish 2022'],
  inflation_data: ['Fed pivot hawkish 2022'],
  market_stress: ['Crise financière mondiale 2008–2009', 'Covid-19 crash initial mars 2020'],
  credit_event: ['Crise financière mondiale 2008–2009'],
  geopolitical_tension: ['Invasion russe de l\'Ukraine 2022', 'Covid-19 crash initial mars 2020'],
  commodity_move: ['Invasion russe de l\'Ukraine 2022'],
  fx_move: ['Fed pivot hawkish 2022'],
  growth_data: ['Crise financière mondiale 2008–2009'],
  employment_data: ['Crise financière mondiale 2008–2009'],
  regulatory_change: [],
  election_event: [],
  earnings_surprise: [],
};

function computeSimilarity(category: string, severity: string, episodeTitle: string): number {
  const episodes = CATEGORY_TO_EPISODES[category] ?? [];
  if (!episodes.includes(episodeTitle)) return 0.1;
  let score = 0.6;
  if (severity === 'critical' || severity === 'systemic') score += 0.25;
  if (severity === 'warning') score += 0.15;
  return Math.min(1, score);
}

@Injectable()
export class AnalogFinderService {
  findAnalogs(
    signalId: string,
    category: string,
    severity: string,
  ): { analogs: HistoricalAnalog[]; insights: RetexInsight[] } {
    const episodeTitles = CATEGORY_TO_EPISODES[category] ?? [];
    const now = new Date().toISOString();

    const analogs: HistoricalAnalog[] = EPISODE_LIBRARY
      .filter((ep) => episodeTitles.includes(ep.episodeTitle))
      .map((ep) => ({
        ...ep,
        id: uuid(),
        signalId,
        similarityScore: computeSimilarity(category, severity, ep.episodeTitle),
        createdAt: now,
      }))
      .sort((a, b) => b.similarityScore - a.similarityScore)
      .slice(0, 3);

    const insights: RetexInsight[] = analogs.flatMap((analog) =>
      analog.assetClassBehaviors.slice(0, 2).map((b: { assetClass: string; avgReturnPct: string; minReturnPct: string; maxReturnPct: string; medianDurationDays: number; dispersionNote: string | null }) => ({
        id: uuid(),
        signalId,
        analogId: analog.id,
        lesson: `Dans l'épisode "${analog.episodeTitle}", la classe d'actifs "${b.assetClass}" a enregistré un rendement moyen de ${b.avgReturnPct}% sur une durée médiane de ${b.medianDurationDays} jours.`,
        applicabilityNote: 'À contextualiser selon la composition du portefeuille actuel et les conditions de marché présentes.',
        observedBehavior: `Rendement : ${b.avgReturnPct}% (fourchette : ${b.minReturnPct}% – ${b.maxReturnPct}%)${b.dispersionNote ? '. ' + b.dispersionNote : ''}`,
        confidenceLevel: analog.similarityScore > 0.7 ? 'medium' : 'low' as 'low' | 'medium' | 'high',
        createdAt: now,
      })),
    );

    return { analogs, insights };
  }
}
