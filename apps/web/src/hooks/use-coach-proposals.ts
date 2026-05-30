// LISA refonte C.2 — Coach proposals hooks.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface CoachProposalLesson {
  lesson_kind: string;
  lesson_text: string;
  confidence: number;
  scope: string;
  expected_impact_usd?: number;
  rationale?: string;
}

export interface CoachProposalParamChange {
  param: string;
  current: unknown;
  proposed: unknown;
  rationale: string;
  expected_impact?: string;
}

export interface CoachProposal {
  id: string;
  created_at: string;
  source: string;
  llm_model: string;
  llm_cost_usd: number;
  feasibility_verdict: 'REACHABLE' | 'NEEDS_CHANGES' | 'UNREALISTIC' | string;
  feasibility_probability_pct: number | null;
  feasibility_rationale: string;
  proposed_lessons: CoachProposalLesson[];
  proposed_parameter_changes: CoachProposalParamChange[];
  risk_warnings: string[];
  status: 'pending' | 'partially_accepted' | 'fully_accepted' | 'rejected' | 'expired';
  reviewed_at: string | null;
  resulted_lesson_ids: string[];
}

export function useCoachProposals(portfolioId: string | null, status: string = 'pending') {
  return useQuery({
    queryKey: ['lisa', 'coach-proposals', portfolioId, status],
    queryFn: () =>
      apiFetch<CoachProposal[]>(`/lisa/coach-proposals/${portfolioId}?status=${status}`),
    enabled: !!portfolioId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useAcceptCoachProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      accepted_lessons,
      accepted_params,
      comment,
    }: {
      id: string;
      accepted_lessons: number[];
      accepted_params: number[];
      comment?: string;
    }) =>
      apiFetch<{ ok: boolean; status: string; resulted_lesson_ids: string[] }>(
        `/lisa/coach-proposals/${id}/accept`,
        {
          method: 'POST',
          body: JSON.stringify({ accepted_lessons, accepted_params, comment }),
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lisa', 'coach-proposals'] });
      void qc.invalidateQueries({ queryKey: ['lisa', 'notifications'] });
      void qc.invalidateQueries({ queryKey: ['lisa', 'scanner-lessons'] });
    },
  });
}

export function useRejectCoachProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: string; comment?: string }) =>
      apiFetch<{ ok: boolean; status: string }>(
        `/lisa/coach-proposals/${id}/reject`,
        {
          method: 'POST',
          body: JSON.stringify({ comment }),
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lisa', 'coach-proposals'] });
      void qc.invalidateQueries({ queryKey: ['lisa', 'notifications'] });
    },
  });
}
