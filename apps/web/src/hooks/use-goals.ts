import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface GoalRow {
  id: string;
  name: string;
  type: string;
  status: string;
  target_amount: string;
  currency: string;
  current_amount: string;
  monthly_contribution: string;
  horizon_months: number;
  target_date: string | null;
  portfolio_id: string;
  created_at: string;
}

export interface FeasibilityResult {
  credibilityScore: number;
  isCredible: boolean;
  impliedAnnualReturnRequired: string;
  tensions: string[];
  levers: { kind: string; description: string; requiredChange: string | null }[];
  riskProfileAdequate: boolean;
  riskProfileNote: string | null;
  gapToTarget: string;
  notes: string | null;
}

export interface ScenarioRow {
  id: string;
  scenarioType: 'prudent' | 'central' | 'ambitieux';
  annualReturnAssumptionPct: string;
  volatilityAssumptionPct: string;
  monthlyContribution: string;
  projectedFinalValue: string;
  shortfallOrSurplus: string;
  estimatedProbability: number | null;
  suggestedAllocation: Record<string, number>;
  assumptions: string[];
  risks: string[];
  failureConditions: string[];
  trajectory: { month: number; projectedValue: string }[];
}

export function useGoals(portfolioId?: string) {
  return useQuery({
    queryKey: ['goals', portfolioId],
    queryFn: () => apiFetch<GoalRow[]>(`/goals${portfolioId ? `?portfolioId=${portfolioId}` : ''}`),
  });
}

export function useGoal(goalId: string | null) {
  return useQuery({
    queryKey: ['goal', goalId],
    queryFn: () => apiFetch<GoalRow>(`/goals/${goalId}`),
    enabled: !!goalId,
  });
}

export function useCreateGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: Record<string, unknown>) => apiFetch('/goals', { method: 'POST', body: JSON.stringify(dto) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['goals'] }),
  });
}

export function useAssessFeasibility(goalId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<FeasibilityResult>(`/goals/${goalId}/assess-feasibility`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['feasibility', goalId] }),
  });
}

export function useFeasibility(goalId: string | null) {
  return useQuery({
    queryKey: ['feasibility', goalId],
    queryFn: () => apiFetch<FeasibilityResult | null>(`/goals/${goalId}/feasibility`),
    enabled: !!goalId,
  });
}

export function useGenerateScenarios(goalId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<ScenarioRow[]>(`/goals/${goalId}/generate-scenarios`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scenarios', goalId] }),
  });
}

export function useScenarios(goalId: string | null) {
  return useQuery({
    queryKey: ['scenarios', goalId],
    queryFn: () => apiFetch<ScenarioRow[]>(`/goals/${goalId}/scenarios`),
    enabled: !!goalId,
  });
}

export function useGeneratePlan(goalId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { scenarioId: string; delegationMode?: string }) =>
      apiFetch(`/goals/${goalId}/generate-plan`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plan', goalId] }),
  });
}

export function usePlan(goalId: string | null) {
  return useQuery({
    queryKey: ['plan', goalId],
    queryFn: () => apiFetch(`/goals/${goalId}/plan`),
    enabled: !!goalId,
  });
}
