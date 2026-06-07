// LISA — Oversold regime status hook (panel dédié mode oversold).
// Source : GET /lisa/oversold-regime/:portfolioId — thermomètre VIX/indice LIVE
// + verdict du gate régime (région-aware US/EU) + prochain scan programmé.

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface OversoldRegimeStatus {
  portfolioId: string;
  universe: string;
  region: 'US' | 'EU';
  enabled: boolean;
  block: boolean;
  reason: string;
  vixLabel: string;
  idxLabel: string;
  vix: number | null;
  vixChgPct: number | null;
  idx5dPct: number | null;
  vixSource: 'live' | 'eod';
  thresholds: { vixMax: number; vixDeltaMax: number; idx5dMin: number };
  rotation: {
    regime: 'offensive' | 'defensive' | null;
    spreadPct: number | null;
    mode: string;
    appliedVixPenalty: number;
  } | null;
  nextScanUtc: string;
  nextScanKind: 'intraday' | 'daily';
  asOf: string;
}

export function useOversoldRegime(portfolioId: string | null) {
  return useQuery({
    queryKey: ['lisa', 'oversold-regime', portfolioId],
    queryFn: () => apiFetch<OversoldRegimeStatus>(`/lisa/oversold-regime/${portfolioId}`),
    enabled: !!portfolioId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
