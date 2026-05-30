'use client';

/**
 * NotificationsBell — B.4.a, badge + dropdown notifications LISA.
 *
 * Affiche cloche 🔔 avec badge unread (count basé sur localStorage
 * last_seen_at, scoped portfolio). Click → dropdown listant les
 * notifications (kill-switch armé, coach proposals pending, etc.).
 *
 * Click "tout marquer lu" → met à jour last_seen au max created_at.
 * Mobile : dropdown right-aligned, max-w 320px.
 */

import { useEffect, useRef, useState } from 'react';
import { useNotifications, type NotificationItem } from '@/hooks/use-notifications';

interface Props {
  portfolioId: string;
}

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'à l\'instant';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours}h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days}j`;
}

function severityClasses(sev: NotificationItem['severity']): string {
  switch (sev) {
    case 'critical': return 'border-l-4 border-rose-500 bg-rose-50 dark:bg-rose-950/30';
    case 'warning': return 'border-l-4 border-amber-500 bg-amber-50 dark:bg-amber-950/30';
    case 'info': return 'border-l-4 border-blue-500 bg-blue-50 dark:bg-blue-950/30';
  }
}

function severityIcon(sev: NotificationItem['severity']): string {
  switch (sev) {
    case 'critical': return '🛑';
    case 'warning': return '⚠️';
    case 'info': return '💡';
  }
}

export function NotificationsBell({ portfolioId }: Props) {
  const [open, setOpen] = useState(false);
  const { items, unreadCount, markAllRead, isLoading } = useNotifications(portfolioId);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const onOpen = () => {
    setOpen((v) => !v);
    if (!open) {
      // Marque lu à l'ouverture
      setTimeout(() => markAllRead(), 100);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={onOpen}
        className="relative inline-flex items-center justify-center rounded-md p-2 hover:bg-muted transition"
        aria-label="Notifications"
      >
        <span className="text-lg">🔔</span>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 w-[320px] max-w-[calc(100vw-2rem)] rounded-lg border bg-card shadow-lg">
          <div className="flex items-center justify-between px-3 py-2 border-b">
            <div className="text-sm font-semibold">🔔 Notifications</div>
            <span className="text-[10px] text-muted-foreground">
              {items.length} total{items.length > 1 ? 's' : ''}
            </span>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {isLoading && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                Chargement…
              </div>
            )}
            {!isLoading && items.length === 0 && (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                Aucune notification.
              </div>
            )}
            {!isLoading && items.map((it) => (
              <div key={it.id} className={`px-3 py-2 ${severityClasses(it.severity)}`}>
                <div className="flex items-start gap-2">
                  <span className="text-sm">{severityIcon(it.severity)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate">{it.title}</div>
                    <div className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">
                      {it.body}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {fmtAge(it.created_at)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
