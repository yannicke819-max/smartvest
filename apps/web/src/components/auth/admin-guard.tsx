'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAdminStatus } from '@/hooks/use-is-admin';

/**
 * Guards an admin-only settings page. Redirects non-admins to /settings.
 *
 * Note: this is a UX-only guard (hides admin pages from non-admin users).
 * Real access control lives in the backend `/admin/*` endpoints which
 * enforce `x-admin-token` + role checks. Front-end gating prevents non-admin
 * users from seeing an empty/error UI when API calls would fail.
 */
export function AdminGuard({ children }: { children: React.ReactNode }) {
  const { isAdmin, isLoaded } = useAdminStatus();
  const router = useRouter();

  useEffect(() => {
    if (isLoaded && !isAdmin) {
      router.replace('/settings');
    }
  }, [isLoaded, isAdmin, router]);

  if (!isLoaded) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <div className="h-6 w-40 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded-lg bg-muted/40" />
      </div>
    );
  }

  if (!isAdmin) return null;

  return <>{children}</>;
}
