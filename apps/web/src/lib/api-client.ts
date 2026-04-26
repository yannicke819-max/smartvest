'use client';

import { createSupabaseBrowserClient } from './supabase/client';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// Module-level cache so every apiFetch call reuses the same client.
let _client: ReturnType<typeof createSupabaseBrowserClient> | null = null;
function getClient() {
  if (!_client) _client = createSupabaseBrowserClient();
  return _client;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };

  try {
    const supabase = getClient();

    // getSession() reads from local storage / cookies — fast but may be null
    // on first render before the client is hydrated.
    let session = (await supabase.auth.getSession()).data.session;

    // Fallback: getUser() makes a network call to Supabase auth — always
    // returns the real current user if the token is in cookies/storage.
    if (!session) {
      const { data } = await supabase.auth.getUser();
      if (data?.user) {
        // Refresh session now that we know the user is authenticated.
        session = (await supabase.auth.getSession()).data.session;
      }
    }

    if (session?.user?.id) headers['x-user-id'] = session.user.id;
    if (session?.access_token) headers['authorization'] = `Bearer ${session.access_token}`;
  } catch {
    // Supabase not configured — proceed without auth headers.
  }

  // cache: 'no-store' force le navigateur à ne pas servir une réponse cachée.
  // Sans ça, des GETs comme /lisa/snapshots peuvent renvoyer une vieille
  // version cachée même si le SQL contient des données plus récentes.
  const res = await fetch(`${API}${path}`, { ...init, headers, cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}
