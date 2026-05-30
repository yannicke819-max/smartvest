// LISA refonte B.3 — Scanner lessons management hooks.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ScannerLessonRow {
  id: string;
  lesson_kind: string;
  lesson_text: string;
  macro_condition: string | null;
  scope: string;
  confidence: number | null;
  sample_size: number | null;
  win_rate_observed: number | null;
  avg_pnl_usd: number | null;
  is_active: boolean;
  derived_from_date: string;
  created_at: string;
  applied: boolean;
  applied_by: string | null;
}

interface ListFilters {
  active?: boolean | null;
  search?: string;
  scope?: string;
  limit?: number;
}

export function useScannerLessons(filters: ListFilters = {}) {
  const params = new URLSearchParams();
  if (filters.active === true) params.set('active', 'true');
  if (filters.active === false) params.set('active', 'false');
  if (filters.search) params.set('search', filters.search);
  if (filters.scope) params.set('scope', filters.scope);
  if (filters.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  return useQuery({
    queryKey: ['lisa', 'scanner-lessons', filters],
    queryFn: () =>
      apiFetch<ScannerLessonRow[]>(`/lisa/scanner-lessons${qs ? `?${qs}` : ''}`),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
}

export function useToggleScannerLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiFetch<{ ok: boolean; lessonId: string; is_active: boolean }>(
        `/lisa/scanner-lessons/${id}`,
        { method: 'PATCH', body: JSON.stringify({ is_active: isActive }) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lisa', 'scanner-lessons'] });
      void qc.invalidateQueries({ queryKey: ['lisa', 'lessons-impact'] });
    },
  });
}

export function useResetKillSwitch(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>(`/lisa/kill-switch-reset/${portfolioId}`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lisa', 'config', portfolioId] });
    },
  });
}
