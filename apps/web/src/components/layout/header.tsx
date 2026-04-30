'use client';

import { Menu, TrendingUp, LogOut, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/ui';
import { KillSwitchBanner } from '@/components/kill-switch-banner';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { User as SupabaseUser } from '@supabase/supabase-js';

export function Header() {
  const toggle = useUIStore((s) => s.toggleSidebar);
  const router = useRouter();
  const [user, setUser] = useState<SupabaseUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
  }, []);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push('/sign-in' as never);
  }

  const initials = user?.email?.slice(0, 2).toUpperCase() ?? '?';
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click/touch
  useEffect(() => {
    if (!menuOpen) return;
    function close(e: MouseEvent | TouchEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
    };
  }, [menuOpen]);

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
          {user && (
            <div className="relative" ref={menuRef}>
              {/* min 36×36 touch target */}
              <button
                onClick={() => setMenuOpen((o) => !o)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label="Mon compte"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary hover:bg-primary/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {initials}
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-10 z-50 w-48 rounded-md border bg-background shadow-lg"
                >
                  <div className="border-b px-3 py-2">
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <User className="h-3 w-3" aria-hidden />
                      {user.email}
                    </p>
                  </div>
                  <button
                    role="menuitem"
                    onClick={() => void handleSignOut()}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-destructive hover:bg-muted transition-colors focus:outline-none focus-visible:bg-muted"
                  >
                    <LogOut className="h-3.5 w-3.5" aria-hidden />
                    Se déconnecter
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
