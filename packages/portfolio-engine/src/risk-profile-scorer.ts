import type {
  HorizonOption,
  ToleranceOption,
  ExperienceLevel,
  LiquidityNeed,
  InvestmentGoal,
  OnboardingAnswers,
} from '@smartvest/shared-types';
import type { RiskProfileId } from '@smartvest/domain';

export interface ScoreDimension {
  label: string;
  score: number;
  max: number;
  explanation: string;
}

export interface ProfileScoreResult {
  profile: RiskProfileId;
  totalScore: number;
  maxScore: number;
  dimensions: ScoreDimension[];
  label: string;
  description: string;
  assumptions: string[];
}

const HORIZON_SCORES: Record<HorizonOption, number> = {
  less_1y: 1,
  '1_3y': 2,
  '3_5y': 3,
  '5_10y': 4,
  more_10y: 5,
};

const TOLERANCE_SCORES: Record<ToleranceOption, number> = {
  no_loss: 1,
  up_10pct: 2,
  up_25pct: 3,
  up_50pct: 4,
  any_loss: 5,
};

const EXPERIENCE_SCORES: Record<ExperienceLevel, number> = {
  none: 1,
  basic: 2,
  moderate: 3,
  advanced: 4,
  expert: 5,
};

const LIQUIDITY_SCORES: Record<LiquidityNeed, number> = {
  high: 1,
  medium: 2,
  low: 3,
  none: 5,
};

const GOAL_SCORES: Record<InvestmentGoal, number> = {
  capital_preservation: 1,
  income: 2,
  moderate_growth: 3,
  strong_growth: 4,
  speculation: 5,
};

function profileFromScore(total: number): RiskProfileId {
  if (total <= 9) return 'prudent';
  if (total <= 14) return 'equilibre';
  if (total <= 19) return 'dynamique';
  return 'offensif';
}

const PROFILE_LABELS: Record<RiskProfileId, string> = {
  prudent: 'Profil Prudent',
  equilibre: 'Profil Équilibré',
  dynamique: 'Profil Dynamique',
  offensif: 'Profil Offensif',
  sur_mesure: 'Profil Sur-mesure',
};

const PROFILE_DESCRIPTIONS: Record<RiskProfileId, string> = {
  prudent:
    'Priorité à la préservation du capital. Votre simulation favorisera les actifs à faible volatilité (obligations, liquidités) avec une exposition limitée aux marchés actions.',
  equilibre:
    "Recherche d'un équilibre entre stabilité et croissance. La simulation combine expositions actions et obligataires avec une gestion prudente de la volatilité.",
  dynamique:
    'Exposition significative aux marchés actions pour un potentiel de croissance supérieur, avec une tolérance aux fluctuations importantes sur la durée.',
  offensif:
    "Orientation forte vers les actifs risqués (actions, ETF, crypto éventuelle). Ce scenario accepte des drawdowns élevés en contrepartie d'un potentiel de croissance long terme.",
  sur_mesure:
    'Paramètres définis manuellement. Validez chaque hypothèse de la simulation selon vos objectifs spécifiques.',
};

const HORIZON_LABELS: Record<HorizonOption, string> = {
  less_1y: "moins d'1 an",
  '1_3y': '1 à 3 ans',
  '3_5y': '3 à 5 ans',
  '5_10y': '5 à 10 ans',
  more_10y: 'plus de 10 ans',
};

const TOLERANCE_LABELS: Record<ToleranceOption, string> = {
  no_loss: 'aucune perte acceptable',
  up_10pct: "jusqu'à -10 %",
  up_25pct: "jusqu'à -25 %",
  up_50pct: "jusqu'à -50 %",
  any_loss: 'perte totale possible',
};

// Calcule le profil à partir des réponses au questionnaire.
// Méthode: score additif pondéré, transparent et rejouable.
// La tolérance et l'horizon ont un poids double — ce sont les déterminants les plus importants.
export function scoreRiskProfile(answers: OnboardingAnswers): ProfileScoreResult {
  const horizonScore = HORIZON_SCORES[answers.horizon];
  const toleranceScore = TOLERANCE_SCORES[answers.tolerance];
  const experienceScore = EXPERIENCE_SCORES[answers.experience];
  const liquidityScore = LIQUIDITY_SCORES[answers.liquidityNeed];
  const goalScore = GOAL_SCORES[answers.goal];

  // Horizon et tolérance pondérés x2 (déterminants principaux).
  const weightedTotal =
    horizonScore * 2 + toleranceScore * 2 + experienceScore + liquidityScore + goalScore;
  const maxWeighted = 5 * 2 + 5 * 2 + 5 + 5 + 5; // 35

  // On normalise sur 25 pour le seuil de profil.
  const normalizedScore = Math.round((weightedTotal / maxWeighted) * 25);

  const profile = profileFromScore(normalizedScore);

  const dimensions: ScoreDimension[] = [
    {
      label: 'Horizon',
      score: horizonScore,
      max: 5,
      explanation: `Horizon ${HORIZON_LABELS[answers.horizon]} → ${horizonScore}/5`,
    },
    {
      label: 'Tolérance',
      score: toleranceScore,
      max: 5,
      explanation: `Tolérance ${TOLERANCE_LABELS[answers.tolerance]} → ${toleranceScore}/5`,
    },
    {
      label: 'Expérience',
      score: experienceScore,
      max: 5,
      explanation: `Expérience déclarée → ${experienceScore}/5`,
    },
    {
      label: 'Liquidité',
      score: liquidityScore,
      max: 5,
      explanation: `Besoin de liquidité → ${liquidityScore}/5`,
    },
    {
      label: 'Objectif',
      score: goalScore,
      max: 5,
      explanation: `Objectif déclaré → ${goalScore}/5`,
    },
  ];

  const assumptions = [
    'Les réponses au questionnaire sont déclaratives — elles ne reflètent pas nécessairement votre situation patrimoniale réelle.',
    'Le profil calculé est une aide à la structuration de vos simulations, pas un conseil en investissement personnalisé.',
    'Vous pouvez réviser ce profil à tout moment depuis les paramètres.',
    'La méthode de scoring est additive et pondérée : horizon et tolérance comptent double.',
  ];

  return {
    profile,
    totalScore: normalizedScore,
    maxScore: 25,
    dimensions,
    label: PROFILE_LABELS[profile],
    description: PROFILE_DESCRIPTIONS[profile],
    assumptions,
  };
}
