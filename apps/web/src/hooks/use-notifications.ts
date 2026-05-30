// LISA refonte B.4.a — In-app notifications hooks.

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface NotificationItem {
  id: string;
  kind: 'kill_switch_armed' | 'coach_proposal_pending';
  severity: 'critical' | 'info' | 'warning';
  title: string;
  body: string;
  created_at: string;
  href?: string;
  payload?: Record<string, unknown>;
}

interface NotificationsResponse {
  items: NotificationItem[];
  total: number;
}

const LS_KEY_PREFIX = 'lisa.notifications.lastSeen.';

export function useNotifications(portfolioId: string | null) {
  const query = useQuery({
    queryKey: ['lisa', 'notifications', portfolioId],
    queryFn: () =>
      apiFetch<NotificationsResponse>(`/lisa/notifications/${portfolioId}`),
    enabled: !!portfolioId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 30_000, // poll 30s
    staleTime: 15_000,
  });

  const [lastSeen, setLastSeenState] = useState<string>(() => {
    if (typeof window === 'undefined' || !portfolioId) return '';
    return localStorage.getItem(`${LS_KEY_PREFIX}${portfolioId}`) ?? '';
  });

  // Reload lastSeen quand portfolio change
  useEffect(() => {
    if (typeof window === 'undefined' || !portfolioId) return;
    setLastSeenState(localStorage.getItem(`${LS_KEY_PREFIX}${portfolioId}`) ?? '');
  }, [portfolioId]);

  const unreadCount = useMemo(() => {
    const items = query.data?.items ?? [];
    if (!lastSeen) return items.length;
    return items.filter((i) => i.created_at > lastSeen).length;
  }, [query.data, lastSeen]);

  const markAllRead = () => {
    if (typeof window === 'undefined' || !portfolioId) return;
    const items = query.data?.items ?? [];
    if (items.length === 0) return;
    const max = items.reduce(
      (acc, i) => (i.created_at > acc ? i.created_at : acc),
      lastSeen,
    );
    localStorage.setItem(`${LS_KEY_PREFIX}${portfolioId}`, max);
    setLastSeenState(max);
  };

  return {
    items: query.data?.items ?? [],
    total: query.data?.total ?? 0,
    unreadCount,
    isLoading: query.isLoading,
    markAllRead,
  };
}
