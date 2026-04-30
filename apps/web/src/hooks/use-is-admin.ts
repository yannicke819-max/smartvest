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

export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createSupabaseBrowserClient();
      const { data } = await supabase.auth.getUser();
      const user = data.user;
      if (cancelled || !user) return;

      const role = (user.app_metadata?.role ?? user.user_metadata?.role) as
        | string
        | undefined;
      if (role === 'admin') {
        setIsAdmin(true);
        return;
      }

      const allowedCsv = process.env.NEXT_PUBLIC_ADMIN_EMAILS ?? '';
      const allowed = allowedCsv
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (user.email && allowed.includes(user.email.toLowerCase())) {
        setIsAdmin(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return isAdmin;
}
