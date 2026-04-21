'use client';

import { Menu, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/ui';
import { KillSwitchBanner } from '@/components/kill-switch-banner';

export function Header() {
  const toggle = useUIStore((s) => s.toggleSidebar);
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Ouvrir le menu"
          onClick={toggle}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <TrendingUp className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight sm:text-base">SmartVest</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <KillSwitchBanner />
          <span className="hidden text-xs text-muted-foreground sm:inline">
            Phase 5 · Délégation
          </span>
        </div>
      </div>
    </header>
  );
}
