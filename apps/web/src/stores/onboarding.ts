'use client';

import { create } from 'zustand';
import type { ToleranceOption, ExperienceLevel } from '@smartvest/shared-types';

export const TOTAL_STEPS = 4;

export type OnboardingStep = 'welcome' | 'experience' | 'tolerance' | 'summary';

const STEPS: OnboardingStep[] = ['welcome', 'experience', 'tolerance', 'summary'];

interface OnboardingState {
  stepIndex: number;
  step: OnboardingStep;
  experience: ExperienceLevel | null;
  tolerance: ToleranceOption | null;
  next: () => void;
  back: () => void;
  setExperience: (v: ExperienceLevel) => void;
  setTolerance: (v: ToleranceOption) => void;
  reset: () => void;
}

const initial = {
  stepIndex: 0,
  step: 'welcome' as OnboardingStep,
  experience: null,
  tolerance: null,
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
  setExperience: (v) => set({ experience: v }),
  setTolerance: (v) => set({ tolerance: v }),
  reset: () => set(initial),
}));
