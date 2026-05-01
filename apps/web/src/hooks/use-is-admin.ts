'use client';

/**
 * ADR-002 Sprint 1 — Hook minimaliste pour gating sidebar `/admin/*`.
 *
 * MVP : un user est "admin" si son `user_metadata.role === 'admin'` OU si son
 * email matche `NEXT_PUBLIC_ADMIN_EMAILS` (CSV configuré côté Vercel).
 *
 * Page-level gating (vrai contrôle d'accès) reste assuré côté backend dans
 * les endpoints `/admin/*` via `x-admin-token`. Ce hook ne sert QUE à cacher
 * le lien dans la sidebar pour les non-admins (réduction du bruit UX).
 */

import { useEffect, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export interface AdminStatus {
  isAdmin: boolean;
  isLoaded: boolean;
}

/**
 * Returns admin status with explicit loading state. Use this when you need to
 * differentiate "still checking" from "confirmed not admin" (e.g. before
 * redirecting non-admins from a guarded page).
 */
export function useAdminStatus(): AdminStatus {
  const [state, setState] = useState<AdminStatus>({ isAdmin: false, isLoaded: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createSupabaseBrowserClient();
      const { data } = await supabase.auth.getUser();
      const user = data.user;
      if (cancelled) return;
      if (!user) {
        setState({ isAdmin: false, isLoaded: true });
        return;
      }

      const role = (user.app_metadata?.role ?? user.user_metadata?.role) as
        | string
        | undefined;
      if (role === 'admin') {
        setState({ isAdmin: true, isLoaded: true });
        return;
      }

      const allowedCsv = process.env.NEXT_PUBLIC_ADMIN_EMAILS ?? '';
      const allowed = allowedCsv
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const isAdmin = !!user.email && allowed.includes(user.email.toLowerCase());
      setState({ isAdmin, isLoaded: true });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/**
 * Backwards-compat boolean variant. Returns `false` during initial load — do
 * not use for redirect guards (race condition on first paint).
 */
export function useIsAdmin(): boolean {
  return useAdminStatus().isAdmin;
}
