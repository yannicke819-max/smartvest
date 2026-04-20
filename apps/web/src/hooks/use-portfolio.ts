'use client';

import { useQuery } from '@tanstack/react-query';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

// Retourne les portefeuilles de l'utilisateur courant.
export function usePortfolios() {
  return useQuery({
    queryKey: ['portfolios'],
    queryFn: async () => {
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase
        .from('portfolios')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
}

export function usePortfolio(id: string | null) {
  return useQuery({
    queryKey: ['portfolio', id],
    enabled: !!id,
    queryFn: async () => {
      if (!id) return null;
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase
        .from('portfolios')
        .select('*, portfolio_accounts(*, brokers(name, slug))')
        .eq('id', id)
        .single();
      if (error) throw new Error(error.message);
      return data;
    },
  });
}

export function useUserProfile() {
  return useQuery({
    queryKey: ['user_profile'],
    queryFn: async () => {
      const supabase = createSupabaseBrowserClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;
      const { data } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single();
      return data ?? null;
    },
  });
}
