'use client';

import { createBrowserClient } from '@supabase/ssr';
import { publicEnv } from '../env';

export function createSupabaseBrowserClient() {
  const url = publicEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase non configuré : renseigner NEXT_PUBLIC_SUPABASE_URL et NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }
  return createBrowserClient(url, key);
}
