// LISA refonte B.2 — Lessons Impact Tracker hook.
//
// Fetch les stats agrégées de citations de lessons par TRADER sur une
// fenêtre glissante (default 30j). Backend agrège côté Nest, ce hook
// expose juste le typage et la fenêtre.

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface LessonImpactRow {
  lesson_id: string | null;
  lesson_kind: string;
  lesson_text: string | null;
  marker_text: string;
  confidence: number | null;
  is_active: boolean | null;
  macro_condition: string | null;
  sample_size: number | null;
  citations_count: number;
  applied_count: number;
  resolved_count: number;
  wins: number;
  losses: number;
  sum_pnl_usd: number;
  avg_pnl_usd: number;
  win_rate_pct: number | null;
  last_cited_at: string | null;
}

export interface LessonsImpactResponse {
  windowDays: number;
  totalCitations: number;
  resolvedCitations: number;
  lessons: LessonImpactRow[];
}

export function useLessonsImpact(portfolioId: string | null, days: number = 30) {
  return useQuery({
    queryKey: ['lisa', 'lessons-impact', portfolioId, days],
    queryFn: () =>
      apiFetch<LessonsImpactResponse>(
        `/lisa/lessons-impact/${portfolioId}?days=${days}`,
      ),
    enabled: !!portfolioId,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
}
