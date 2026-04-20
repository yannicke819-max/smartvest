'use client';

import { create } from 'zustand';
import type {
  HorizonOption,
  ToleranceOption,
  ExperienceLevel,
  LiquidityNeed,
  InvestmentGoal,
  PortfolioType,
} from '@smartvest/shared-types';
import type { ProfileScoreResult } from '@smartvest/portfolio-engine';

export const TOTAL_STEPS = 8;

export type OnboardingStep =
  | 'welcome'
  | 'disclaimer'
  | 'currency'
  | 'horizon'
  | 'tolerance'
  | 'goal'
  | 'profile'
  | 'portfolio';

const STEPS: OnboardingStep[] = [
  'welcome',
  'disclaimer',
  'currency',
  'horizon',
  'tolerance',
  'goal',
  'profile',
  'portfolio',
];

interface OnboardingState {
  stepIndex: number;
  step: OnboardingStep;
  // Answers
  baseCurrency: string;
  horizon: HorizonOption | null;
  tolerance: ToleranceOption | null;
  experience: ExperienceLevel | null;
  liquidityNeed: LiquidityNeed | null;
  goal: InvestmentGoal | null;
  // Computed
  scoreResult: ProfileScoreResult | null;
  // Portfolio
  portfolioName: string;
  portfolioType: PortfolioType;
  // Actions
  next: () => void;
  back: () => void;
  setBaseCurrency: (v: string) => void;
  setHorizon: (v: HorizonOption) => void;
  setTolerance: (v: ToleranceOption) => void;
  setExperience: (v: ExperienceLevel) => void;
  setLiquidityNeed: (v: LiquidityNeed) => void;
  setGoal: (v: InvestmentGoal) => void;
  setScoreResult: (v: ProfileScoreResult) => void;
  setPortfolioName: (v: string) => void;
  setPortfolioType: (v: PortfolioType) => void;
  reset: () => void;
}

const initial = {
  stepIndex: 0,
  step: 'welcome' as OnboardingStep,
  baseCurrency: 'EUR',
  horizon: null,
  tolerance: null,
  experience: null,
  liquidityNeed: null,
  goal: null,
  scoreResult: null,
  portfolioName: 'Mon portefeuille',
  portfolioType: 'long_term' as PortfolioType,
};

export const useOnboardingStore = create<OnboardingState>((set) => ({
  ...initial,
  next: () =>
    set((s) => {
      const next = Math.min(s.stepIndex + 1, STEPS.length - 1);
      return { stepIndex: next, step: STEPS[next] };
    }),
  back: () =>
    set((s) => {
      const prev = Math.max(s.stepIndex - 1, 0);
      return { stepIndex: prev, step: STEPS[prev] };
    }),
  setBaseCurrency: (v) => set({ baseCurrency: v }),
  setHorizon: (v) => set({ horizon: v }),
  setTolerance: (v) => set({ tolerance: v }),
  setExperience: (v) => set({ experience: v }),
  setLiquidityNeed: (v) => set({ liquidityNeed: v }),
  setGoal: (v) => set({ goal: v }),
  setScoreResult: (v) => set({ scoreResult: v }),
  setPortfolioName: (v) => set({ portfolioName: v }),
  setPortfolioType: (v) => set({ portfolioType: v }),
  reset: () => set(initial),
}));
