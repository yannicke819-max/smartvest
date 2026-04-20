'use client';

import type { ReactNode } from 'react';
import { Header } from './header';
import { Sidebar } from './sidebar';
import { useUIStore } from '@/stores/ui';
import { cn } from '@/lib/utils';

export function AppShell({ children }: { children: ReactNode }) {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebar = useUIStore((s) => s.setSidebar);

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <div className="flex flex-1">
        <Sidebar />
        {sidebarOpen ? (
          <button
            type="button"
            aria-label="Fermer le menu"
            className="fixed inset-0 top-14 z-20 bg-black/40 md:hidden"
            onClick={() => setSidebar(false)}
          />
        ) : null}
        <main
          className={cn(
            'flex-1 px-4 py-6 sm:px-6 lg:px-8',
            'mx-auto w-full max-w-6xl',
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
