'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BarChart3,
  Bell,
  Brain,
  Dices,
  FlaskConical,
  History,
  LayoutDashboard,
  Settings,
  Sliders,
  SlidersHorizontal,
  Wallet,
  Activity,
  Bot,
  BookOpen,
} from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { cn } from '@/lib/utils';

// ADR-002 Sprint 1 — Vocabulaire grand public.
// Routes inchangées (préserve deeplinks/bookmarks). Seuls les `label` changent.
// `adminOnly` masque l'item pour les non-admins (RBAC côté UI ; gating réel
// côté backend via `x-admin-token`).
const items = [
  { href: '/', label: 'Mon tableau de bord', icon: LayoutDashboard },
  { href: '/portfolio', label: 'Mon portefeuille', icon: Wallet },
  { href: '/performance', label: 'Mes résultats', icon: BarChart3 },
  { href: '/lisa', label: 'Mon assistant Lisa', icon: Brain },
  { href: '/lisa/parameters', label: 'Paramètres adaptatifs', icon: SlidersHorizontal },
  { href: '/backtest', label: 'Tester sur le passé', icon: FlaskConical },
  { href: '/monte-carlo', label: 'Projections futures', icon: Dices },
  { href: '/optimizer', label: 'Améliorer mon portefeuille', icon: Sliders },
  { href: '/bot-lab', label: 'Mes stratégies auto (mode démo)', icon: Bot },
  { href: '/alerts', label: 'Mes notifications', icon: Bell },
  { href: '/history', label: 'Mes opérations', icon: History },
  { href: '/settings', label: 'Mon compte', icon: Settings },
  { href: '/help', label: 'Aide', icon: BookOpen },
  { href: '/admin/monitoring', label: 'Monitoring', icon: Activity, adminOnly: true },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebar = useUIStore((s) => s.setSidebar);
  const isAdmin = useIsAdmin();

  const visibleItems = items.filter((item) => !('adminOnly' in item && item.adminOnly) || isAdmin);

  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 top-14 z-30 w-60 border-r bg-background transition-transform',
        'md:sticky md:top-14 md:h-[calc(100vh-3.5rem)] md:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      )}
      aria-label="Navigation principale"
    >
      <nav className="flex flex-col gap-1 p-3">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              // Some items (performance, alerts, history, settings top-level) are
              // placeholders pending dedicated pages. Cast escapes typedRoutes
              // strictness; actual 404 would be clearly visible in UX.
              href={item.href as Route}
              onClick={() => setSidebar(false)}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
