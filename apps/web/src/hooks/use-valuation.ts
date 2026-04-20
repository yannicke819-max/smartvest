'use client';

import { useQuery } from '@tanstack/react-query';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function getAuthToken(): Promise<string | null> {
  const supabase = createSupabaseBrowserClient();
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export interface PositionValuation {
  positionId: string;
  assetId: string;
  ticker: string;
  assetClass: string;
  quantity: string;
  averageCost: string;
  costCurrency: string;
  currentPrice: string | null;
  priceCurrency: string | null;
  marketValue: string;
  costBasis: string;
  pnlAbsolute: string;
  pnlPercent: string;
  priceAsOf: string | null;
  marketState: string;
  changePercent: string | null;
}

export interface PortfolioValuation {
  portfolioId: string;
  currency: string;
  totalMarketValue: string;
  totalCostBasis: string;
  pnlAbsolute: string;
  pnlPercent: string;
  positionCount: number;
  valuedAt: string;
  positions: PositionValuation[];
}

export interface AllocationBreakdown {
  byClass: Record<string, { value: string; weight: number }>;
  byCurrency: Record<string, { value: string; weight: number }>;
}

export interface PortfolioAlert {
  ruleId: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  affectedTicker?: string;
  value?: string;
  threshold?: string;
  detectedAt: string;
}

export function useValuation(portfolioId: string | null) {
  return useQuery<PortfolioValuation>({
    queryKey: ['valuation', portfolioId],
    enabled: !!portfolioId,
    staleTime: 60_000,
    queryFn: async () => {
      const token = await getAuthToken();
      const headers: Record<string, string> = token
        ? { authorization: `Bearer ${token}` }
        : {};
      const res = await fetch(`${API_BASE}/portfolio/${portfolioId}/valuation`, { headers });
      if (!res.ok) throw new Error(`Valuation fetch failed: ${res.status}`);
      const json = await res.json();
      return json.data as PortfolioValuation;
    },
  });
}

export function useAllocation(portfolioId: string | null) {
  return useQuery<AllocationBreakdown>({
    queryKey: ['allocation', portfolioId],
    enabled: !!portfolioId,
    staleTime: 60_000,
    queryFn: async () => {
      const token = await getAuthToken();
      const headers: Record<string, string> = token
        ? { authorization: `Bearer ${token}` }
        : {};
      const res = await fetch(`${API_BASE}/portfolio/${portfolioId}/allocation`, { headers });
      if (!res.ok) throw new Error(`Allocation fetch failed: ${res.status}`);
      const json = await res.json();
      return json.data as AllocationBreakdown;
    },
  });
}

export function useAlerts(portfolioId: string | null) {
  return useQuery<PortfolioAlert[]>({
    queryKey: ['alerts', portfolioId],
    enabled: !!portfolioId,
    staleTime: 120_000,
    queryFn: async () => {
      const token = await getAuthToken();
      const headers: Record<string, string> = token
        ? { authorization: `Bearer ${token}` }
        : {};
      const res = await fetch(`${API_BASE}/portfolio/${portfolioId}/alerts`, { headers });
      if (!res.ok) throw new Error(`Alerts fetch failed: ${res.status}`);
      const json = await res.json();
      return json.data as PortfolioAlert[];
    },
  });
}
