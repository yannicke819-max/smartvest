'use client';

import { useQuery } from '@tanstack/react-query';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export interface PositionWithAsset {
  id: string;
  quantity: string;
  average_cost: string;
  cost_currency: string;
  assets: {
    id: string;
    ticker: string;
    name: string;
    asset_class: string;
    currency: string;
  } | null;
  latest_price: string | null;
}

export interface DashboardSummary {
  totalValue: number;
  totalCost: number;
  pnlAbsolute: number;
  pnlPercent: number;
  positionCount: number;
  allocationByClass: Record<string, number>;
  positions: PositionWithAsset[];
}

export function usePositions(portfolioId: string | null) {
  return useQuery({
    queryKey: ['positions', portfolioId],
    enabled: !!portfolioId,
    queryFn: async () => {
      if (!portfolioId) return [];
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase
        .from('positions')
        .select(`
          id, quantity, average_cost, cost_currency,
          assets(id, ticker, name, asset_class, currency),
          portfolio_accounts!inner(portfolio_id)
        `)
        .eq('portfolio_accounts.portfolio_id', portfolioId)
        .is('closed_at', null);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as PositionWithAsset[];
    },
  });
}

export function useRecentTransactions(portfolioId: string | null, limit = 10) {
  return useQuery({
    queryKey: ['recent_transactions', portfolioId, limit],
    enabled: !!portfolioId,
    queryFn: async () => {
      if (!portfolioId) return [];
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase
        .from('transactions')
        .select(`
          id, type, trade_date, quantity, unit_price, currency, note,
          assets(ticker, name),
          portfolio_accounts!inner(portfolio_id)
        `)
        .eq('portfolio_accounts.portfolio_id', portfolioId)
        .order('trade_date', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
}

export function useLatestQuotes(assetIds: string[]) {
  return useQuery({
    queryKey: ['latest_quotes', assetIds.sort().join(',')],
    enabled: assetIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      if (assetIds.length === 0) return [];
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase
        .from('latest_quotes')
        .select('*')
        .in('asset_id', assetIds);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
}
