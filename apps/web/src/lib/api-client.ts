'use client';

import { createSupabaseBrowserClient } from './supabase/client';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Shared API client for calls to the NestJS backend.
 *
 * Sends the authenticated Supabase user's ID as `x-user-id`, which the
 * backend controllers read via `extractUserId(headers)`. Without this, the
 * backend falls back to the literal string "demo-user", which PostgreSQL
 * rejects because `user_id` columns are typed as UUID.
 *
 * Also forwards the Supabase access token as Bearer for future JWT-based
 * validation on the backend (currently unused — kept for forward-compat).
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };

  try {
    const supabase = createSupabaseBrowserClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user?.id) headers['x-user-id'] = session.user.id;
    if (session?.access_token) headers['authorization'] = `Bearer ${session.access_token}`;
  } catch {
    // Supabase not configured — proceed anonymously; backend will fallback
    // to "demo-user" and likely reject on UUID columns.
  }

  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}
