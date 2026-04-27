'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type BotSourceType = 'csv_import' | 'api_external' | 'lisa_replay' | 'manual';

export interface BotDefinition {
  id: string;
  userId: string;
  portfolioId: string | null;
  name: string;
  description: string | null;
  sourceType: BotSourceType;
  capitalBaseUsd: string;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  tags: string[];
  totalTrades: number;
  totalRealizedPnlUsd: string;
  createdAt: string;
  updatedAt: string;
}

export interface BotPaperTrade {
  id: string;
  botId: string;
  symbol: string;
  assetClass: string;
  direction: string;
  entryTimestamp: string;
  entryPrice: string;
  exitTimestamp: string | null;
  exitPrice: string | null;
  netPnlUsd: string | null;
  netPnlPct: number | null;
  marketRegime: string | null;
}

export interface BotDefinitionDraft {
  name: string;
  description?: string;
  sourceType: BotSourceType;
  capitalBaseUsd: number;
  startDate?: string;
  endDate?: string;
  tags?: string[];
}

/** Liste les bots de l'utilisateur. */
export function useBots(activeOnly = false) {
  return useQuery({
    queryKey: ['bot-lab', 'bots', activeOnly],
    queryFn: () => apiFetch<{ bots: BotDefinition[] }>(`/bot-lab/bots${activeOnly ? '?active_only=true' : ''}`),
  });
}

/** Récupère un bot. */
export function useBot(botId: string | null) {
  return useQuery({
    queryKey: ['bot-lab', 'bot', botId],
    queryFn: () => apiFetch<{ bot: BotDefinition }>(`/bot-lab/bots/${botId}`),
    enabled: !!botId,
  });
}

/** Liste les trades d'un bot. */
export function useBotTrades(botId: string | null, limit = 100) {
  return useQuery({
    queryKey: ['bot-lab', 'trades', botId, limit],
    queryFn: () => apiFetch<{ trades: BotPaperTrade[] }>(`/bot-lab/bots/${botId}/trades?limit=${limit}`),
    enabled: !!botId,
  });
}

/** Crée un bot. */
export function useCreateBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (draft: BotDefinitionDraft) =>
      apiFetch<{ bot: BotDefinition }>('/bot-lab/bots', {
        method: 'POST',
        body: JSON.stringify(draft),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-lab', 'bots'] });
    },
  });
}

/** Supprime un bot. */
export function useDeleteBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (botId: string) =>
      apiFetch<{ ok: true }>(`/bot-lab/bots/${botId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-lab', 'bots'] });
    },
  });
}

/** Importe un CSV de trades. */
export function useImportCsv(botId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (csv: string) =>
      apiFetch<{ inserted: number; skipped: number; errors: number; totalParsed: number }>(
        `/bot-lab/bots/${botId}/import-csv`,
        { method: 'POST', body: JSON.stringify({ csv }) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-lab', 'bot', botId] });
      qc.invalidateQueries({ queryKey: ['bot-lab', 'trades', botId] });
      qc.invalidateQueries({ queryKey: ['bot-lab', 'bots'] });
    },
  });
}
