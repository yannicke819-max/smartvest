import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicEnv } from '../env';

export function createSupabaseServerClient() {
  const url = publicEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Supabase non configuré côté serveur.');
  }
  const cookieStore = cookies();
  return createServerClient(url, key, {
    cookies: {
      get(name) {
        return cookieStore.get(name)?.value;
      },
      set(name, value, options) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // Route Handlers uniquement — ignoré en Server Components.
        }
      },
      remove(name, options) {
        try {
          cookieStore.set({ name, value: '', ...options });
        } catch {
          // Idem.
        }
      },
    },
  });
}
