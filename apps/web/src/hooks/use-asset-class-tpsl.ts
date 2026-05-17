'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * PR #338 — accès lecture/écriture à la matrice TP/SL par asset_class
 * (table `asset_class_tpsl_config`, migrations 0141 + 0142).
 */
export interface AssetClassTpslRow {
  asset_class: string;
  tp_pct: number;
  sl_pct: number;
  warmup_min_override: number | null;
  regime_filter_enabled: boolean;
  score_min_floor: number | null;
  path_eff_floor: number | null;
  notes: string | null;
  updated_at: string;
}

export function useAssetClassTpsl() {
  return useQuery({
    queryKey: ['asset-class-tpsl'],
    queryFn: () => apiFetch<AssetClassTpslRow[]>('/lisa/asset-class-tpsl'),
    refetchInterval: 60_000,
  });
}

export function useUpdateAssetClassTpsl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ assetClass, patch }: { assetClass: string; patch: Partial<AssetClassTpslRow> }) =>
      apiFetch<AssetClassTpslRow>(`/lisa/asset-class-tpsl/${assetClass}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['asset-class-tpsl'] });
    },
  });
}
