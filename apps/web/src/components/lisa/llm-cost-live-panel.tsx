'use client';

/**
 * LlmCostLivePanel — affiche le compteur LLM temps réel pour les 4 providers
 * sur les 5 call sites SmartVest. Lit depuis /lisa/llm-cost-live (refresh 30s).
 *
 * Apparait dans la page /lisa, complète l'ancien compteur Gemini qui lisait
 * api_costs_daily (aggregé en fin de journée UTC, "figé" intra-day).
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface ProviderStats {
  calls: number;
  cost_usd: number;
  avg_latency_ms: number | null;
}

interface SiteStats {
  call_site: string;
  cycles: number;
  cost_usd: number;
}

interface LlmCostLiveResponse {
  since: string;
  until: string;
  total_cost_usd: number;
  total_cycles: number;
  providers: Record<string, ProviderStats>;
  by_site: SiteStats[];
}

const PROVIDER_LABELS: Record<string, { label: string; color: string }> = {
  'gemini-pro': { label: 'Gemini 2.5 Pro', color: 'bg-blue-500' },
  'gemini-flash': { label: 'Gemini 2.5 Flash', color: 'bg-cyan-500' },
  'mistral-medium': { label: 'Mistral Medium 3.5', color: 'bg-orange-500' },
  'mistral-large': { label: 'Mistral Large 3', color: 'bg-amber-500' },
};

const SITE_LABELS: Record<string, string> = {
  trader_decision: 'TRADER decisions',
  scanner_postmortem: 'Scanner post-mortem',
  strategy_coach: 'Strategy coach',
  daily_brief: 'Daily catalyst brief',
  risk_monitor: 'Risk monitor',
};

export function LlmCostLivePanel() {
  const { data, isLoading, isError } = useQuery<LlmCostLiveResponse>({
    queryKey: ['lisa', 'llm-cost-live'],
    queryFn: () => apiFetch<LlmCostLiveResponse>('/lisa/llm-cost-live'),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
    staleTime: 25_000,
  });

  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-gray-700">Coût LLM temps réel</h3>
        <p className="text-xs text-gray-500">Chargement…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-gray-700">Coût LLM temps réel</h3>
        <p className="text-xs text-red-600">Erreur de chargement</p>
      </div>
    );
  }

  const since = new Date(data.since);
  const fmtSince = since.toISOString().slice(11, 16) + ' UTC';

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Coût LLM temps réel</h3>
        <span className="text-xs text-gray-500">depuis {fmtSince}</span>
      </div>

      <div className="mb-4 flex items-baseline justify-between border-b border-gray-100 pb-3">
        <span className="text-2xl font-bold text-gray-900">${data.total_cost_usd.toFixed(2)}</span>
        <span className="text-xs text-gray-500">{data.total_cycles} cycles</span>
      </div>

      <div className="space-y-2">
        {Object.entries(data.providers).map(([key, p]) => {
          const meta = PROVIDER_LABELS[key] ?? { label: key, color: 'bg-gray-400' };
          const pct = data.total_cost_usd > 0 ? (p.cost_usd / data.total_cost_usd) * 100 : 0;
          return (
            <div key={key} className="flex items-center gap-3 text-xs">
              <div className={`h-2 w-2 rounded-full ${meta.color}`} aria-hidden />
              <span className="flex-1 font-medium text-gray-700">{meta.label}</span>
              <span className="text-gray-500">{p.calls} calls</span>
              <span className="w-16 text-right font-mono text-gray-900">${p.cost_usd.toFixed(3)}</span>
              {p.avg_latency_ms !== null && (
                <span className="w-14 text-right text-gray-500">{(p.avg_latency_ms / 1000).toFixed(1)}s</span>
              )}
              <span className="w-10 text-right text-gray-400">{pct.toFixed(0)}%</span>
            </div>
          );
        })}
      </div>

      {data.by_site.length > 0 && (
        <details className="mt-4 border-t border-gray-100 pt-3">
          <summary className="cursor-pointer text-xs text-gray-600">Détail par call site ({data.by_site.length})</summary>
          <div className="mt-2 space-y-1">
            {data.by_site
              .sort((a, b) => b.cost_usd - a.cost_usd)
              .map((s) => (
                <div key={s.call_site} className="flex items-center justify-between text-xs">
                  <span className="text-gray-600">{SITE_LABELS[s.call_site] ?? s.call_site}</span>
                  <span className="font-mono text-gray-900">
                    ${s.cost_usd.toFixed(3)} ({s.cycles})
                  </span>
                </div>
              ))}
          </div>
        </details>
      )}

      <p className="mt-3 text-[10px] text-gray-400">
        Refresh 30s — source : gemini_ab_decisions + llm_ab_shadow_decisions (vs api_costs_daily figé EOD)
      </p>
    </div>
  );
}
