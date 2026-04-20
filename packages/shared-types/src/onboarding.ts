import { z } from 'zod';

export const HorizonOption = z.enum(['less_1y', '1_3y', '3_5y', '5_10y', 'more_10y']);
export type HorizonOption = z.infer<typeof HorizonOption>;

export const ToleranceOption = z.enum([
  'no_loss',    // tolérance zéro — capital préservé avant tout
  'up_10pct',   // accepte jusqu'à -10%
  'up_25pct',   // accepte jusqu'à -25%
  'up_50pct',   // accepte jusqu'à -50%
  'any_loss',   // tolérance maximale
]);
export type ToleranceOption = z.infer<typeof ToleranceOption>;

export const ExperienceLevel = z.enum([
  'none',       // aucune expérience
  'basic',      // livret, fonds euros
  'moderate',   // ETF, quelques actions
  'advanced',   // options, crypto, marchés dérivés
  'expert',     // gestion active, stratégies complexes
]);
export type ExperienceLevel = z.infer<typeof ExperienceLevel>;

export const LiquidityNeed = z.enum([
  'high',       // besoin de pouvoir sortir sous 1 mois
  'medium',     // horizon 3-12 mois
  'low',        // pas besoin avant 1-3 ans
  'none',       // capital totalement bloquable à long terme
]);
export type LiquidityNeed = z.infer<typeof LiquidityNeed>;

export const InvestmentGoal = z.enum([
  'capital_preservation',  // préserver le capital
  'income',               // générer des revenus / dividendes
  'moderate_growth',      // croissance modérée avec sécurité
  'strong_growth',        // croissance forte, risque accepté
  'speculation',          // gains élevés, perte totale possible
]);
export type InvestmentGoal = z.infer<typeof InvestmentGoal>;

export const OnboardingAnswers = z.object({
  baseCurrency: z.string().length(3).default('EUR'),
  horizon: HorizonOption,
  tolerance: ToleranceOption,
  experience: ExperienceLevel,
  liquidityNeed: LiquidityNeed,
  goal: InvestmentGoal,
});
export type OnboardingAnswers = z.infer<typeof OnboardingAnswers>;

export const PortfolioType = z.enum([
  'long_term',      // investissement long terme, buy & hold
  'active_trading', // trading actif, rotation fréquente
  'mixed',          // approche hybride
  'experimental',   // portefeuille test, sommes limitées
]);
export type PortfolioType = z.infer<typeof PortfolioType>;

export const OnboardingPortfolioData = z.object({
  name: z.string().min(1).max(120),
  baseCurrency: z.string().length(3),
  portfolioType: PortfolioType,
});
export type OnboardingPortfolioData = z.infer<typeof OnboardingPortfolioData>;
