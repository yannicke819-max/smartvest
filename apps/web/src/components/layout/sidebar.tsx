'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BarChart3,
  Bell,
  Brain,
  FlaskConical,
  History,
  LayoutDashboard,
  Settings,
  Sliders,
  Wallet,
  Activity,
} from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { cn } from '@/lib/utils';

const items = [
  { href: '/', label: 'Tableau de bord', icon: LayoutDashboard },
  { href: '/portfolio', label: 'Portefeuille', icon: Wallet },
  { href: '/performance', label: 'Performance', icon: BarChart3 },
  { href: '/lisa', label: 'Lisa', icon: Brain },
  { href: '/backtest', label: 'Backtest', icon: FlaskConical },
  { href: '/optimizer', label: 'Optimizer', icon: Sliders },
  { href: '/alerts', label: 'Alertes', icon: Bell },
  { href: '/history', label: 'Historique', icon: History },
  { href: '/settings', label: 'Paramètres', icon: Settings },
  { href: '/admin/monitoring', label: 'Monitoring', icon: Activity },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebar = useUIStore((s) => s.setSidebar);

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
        {items.map((item) => {
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
