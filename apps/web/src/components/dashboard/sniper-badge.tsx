'use client';

import Link from 'next/link';
import { Target, Timer } from 'lucide-react';
import { useSniperStatus } from '@/hooks/use-sniper';

function formatRemaining(s: number | null): string {
  if (s === null) return '—';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Compact badge surfaced in the dashboard toolbar when sniper is active.
 * Renders nothing when the mode is STANDARD or SNIPER_LOCKED — no visual
 * noise unless the surcouche is live.
 */
export function SniperBadge() {
  const { data } = useSniperStatus(5_000);
  if (!data || data.mode !== 'SNIPER_ACTIVE') return null;

  return (
    <Link
      href="/settings/sniper"
      className="flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
      title="Sniper actif — cliquez pour gérer la session"
    >
      <Target className="h-3 w-3" />
      Sniper
      <span className="flex items-center gap-0.5 font-mono tabular-nums">
        <Timer className="h-2.5 w-2.5" />
        {formatRemaining(data.secondsRemaining)}
      </span>
    </Link>
  );
}
