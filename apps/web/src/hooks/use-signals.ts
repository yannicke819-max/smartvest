import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json() as Promise<T>;
}

export interface SignalRow {
  id: string;
  category: string;
  status: string;
  title: string;
  summary: string;
  severity: 'info' | 'watch' | 'warning' | 'critical' | 'systemic';
  confidence: 'low' | 'medium' | 'high';
  impact_horizon: string;
  geographic_zones: string[];
  affected_sectors: string[];
  affected_currencies: string[];
  occurred_at: string;
}

export interface SignalConclusion {
  summaryText: string;
  exposedAssets: string[];
  exposedSectors: string[];
  probableScenario: string;
  mainRisk: string;
  counterArguments: string[];
  overallConfidence: string;
  needsReview: boolean;
  outputMode: string;
  proposedActions: string[];
  delegationMode: string;
}

export function useSignals(filters?: { category?: string; severity?: string }) {
  const params = new URLSearchParams();
  if (filters?.category) params.set('category', filters.category);
  if (filters?.severity) params.set('severity', filters.severity);
  const qs = params.toString();
  return useQuery({
    queryKey: ['signals', filters],
    queryFn: () => apiFetch<SignalRow[]>(`/signals${qs ? `?${qs}` : ''}`),
  });
}

export function useSignal(id: string | null) {
  return useQuery({
    queryKey: ['signal', id],
    queryFn: () => apiFetch<SignalRow>(`/signals/${id}`),
    enabled: !!id,
  });
}

export function useWatchSignals() {
  return useQuery({
    queryKey: ['signals-watch'],
    queryFn: () => apiFetch<SignalRow[]>('/signals/watch'),
  });
}

export function useIngestSignal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: Record<string, unknown>) =>
      apiFetch('/signals/ingest', { method: 'POST', body: JSON.stringify(dto) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['signals'] }),
  });
}

export function useAssessImpact(signalId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (portfolioId: string) =>
      apiFetch(`/signals/${signalId}/assess-impact`, { method: 'POST', body: JSON.stringify({ portfolioId }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['signal', signalId] }),
  });
}

export function useFindAnalogs(signalId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch(`/signals/${signalId}/find-analogs`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['signal', signalId] }),
  });
}

export function useGenerateConclusion(signalId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<SignalConclusion>(`/signals/${signalId}/generate-conclusion`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['signal', signalId] }),
  });
}

export function useMarketContext(portfolioId: string | null) {
  return useQuery({
    queryKey: ['market-context', portfolioId],
    queryFn: () => apiFetch<{
      watchSignals: SignalRow[];
      recentConclusions: (SignalConclusion & { id: string; macro_signals: { title: string; category: string; severity: string } })[];
    }>(`/portfolio/${portfolioId}/market-context`),
    enabled: !!portfolioId,
  });
}
