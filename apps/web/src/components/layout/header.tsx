'use client';

import { Menu, TrendingUp, LogOut, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/ui';
import { KillSwitchBanner } from '@/components/kill-switch-banner';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
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
            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary hover:bg-primary/20 transition-colors"
                aria-label="Mon compte"
              >
                {initials}
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-10 z-50 w-48 rounded-md border bg-background shadow-lg">
                  <div className="border-b px-3 py-2">
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <User className="h-3 w-3" />
                      {user.email}
                    </p>
                  </div>
                  <button
                    onClick={() => void handleSignOut()}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-muted transition-colors"
                  >
                    <LogOut className="h-3.5 w-3.5" />
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
