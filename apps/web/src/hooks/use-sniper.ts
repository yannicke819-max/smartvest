'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type PersonalOverrideMode = 'STANDARD' | 'SNIPER_LOCKED' | 'SNIPER_ACTIVE';
export type SniperSessionStatus = 'unlocked' | 'expired' | 'revoked';

export interface SniperSessionRow {
  id: string;
  user_id: string;
  status: SniperSessionStatus;
  unlock_method: 'local_code';
  unlocked_at: string;
  expires_at: string;
  revoked_at: string | null;
  ttl_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface SniperStatus {
  mode: PersonalOverrideMode;
  session: SniperSessionRow | null;
  secondsRemaining: number | null;
}

export function useSniperStatus(refetchMs: number | false = 15_000) {
  return useQuery({
    queryKey: ['sniper', 'status'],
    queryFn: () => apiFetch<SniperStatus>('/sniper/status'),
    // Tick every 15s so the countdown stays fresh while active.
    refetchInterval: refetchMs,
    staleTime: 5_000,
  });
}

export function useSniperHistory() {
  return useQuery({
    queryKey: ['sniper', 'history'],
    queryFn: () => apiFetch<SniperSessionRow[]>('/sniper/history'),
    staleTime: 30_000,
  });
}

export function useUnlockSniper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { code: string; ttlMinutes?: number }) =>
      apiFetch<SniperSessionRow>('/sniper/unlock', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sniper'] });
    },
  });
}

export function useDeactivateSniper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) =>
      apiFetch<SniperSessionRow>('/sniper/deactivate', {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sniper'] });
    },
  });
}
