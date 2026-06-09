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
  // 07/06 — Vrai registre api_costs_daily (le compteur A/B ci-dessus est gelé).
  ledger: {
    today_date: string;
    today_cost_usd: number;
    today_by_model: Record<string, number>;
    month_label: string;
    month_cost_usd: number;
    year_label: string;
    year_cost_usd: number;
    last_date: string | null;
    last_cost_usd: number;
    last_by_model: Record<string, number>;
  };
}

const PROVIDER_LABELS: Record<string, { label: string; color: string }> = {
  'gemini-pro': { label: 'Gemini 2.5 Pro', color: 'bg-blue-500' },
  'gemini-flash': { label: 'Gemini 2.5 Flash', color: 'bg-cyan-500' },
  'mistral-medium': { label: 'Mistral Medium 2505', color: 'bg-orange-500' },
  'mistral-large': { label: 'Mistral Large 3', color: 'bg-amber-500' },
  'magistral-medium': { label: 'Magistral Medium 2509', color: 'bg-red-500' },
};

// 03/06/2026 — Mistral PAYG activé (MISTRAL_FREE_TIER=false). Le backend
// renvoie maintenant le vrai coût Mistral. Le mapping a aussi été fixé
// (lisa.controller.ts) — précédemment Mistral cost était attribué à
// gemini-flash par erreur. Plus de masking front.
const MISTRAL_FREE_TIER_BUCKETS = new Set<string>();

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
        <h3 className="text-sm font-semibold text-gray-700">Coût LLM réel (registre)</h3>
        <span className="text-xs text-gray-500">{data.ledger.today_date}</span>
      </div>

      {/* Headline = vrai coût du jour (api_costs_daily), pas les tables A/B gelées. */}
      <div className="mb-4 border-b border-gray-100 pb-3">
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-bold text-gray-900">${data.ledger.today_cost_usd.toFixed(2)}</span>
          <span className="text-xs text-gray-500">coût réel aujourd&apos;hui</span>
        </div>
        {/* Répartition du JOUR par famille — montre explicitement Gemini $0, pour
            lever la confusion récurrente avec le cumul annuel (qui inclut un
            historique Gemini gelé pré-05/06 qui ne baissera jamais). */}
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
          {(['mistral', 'gemini', 'claude'] as const).map((fam) => {
            const famCost = Object.entries(data.ledger.today_by_model)
              .filter(([m]) => m.toLowerCase().includes(fam))
              .reduce((s, [, c]) => s + Number(c), 0);
            const label = fam === 'mistral' ? 'Mistral' : fam === 'gemini' ? 'Gemini' : 'Claude';
            const zero = famCost === 0;
            return (
              <span key={fam} className={zero ? 'text-gray-400' : 'font-medium text-gray-700'}>
                {label}: ${famCost.toFixed(2)}
                {fam === 'gemini' && zero && <span className="text-green-600"> ✓ off</span>}
              </span>
            );
          })}
        </div>
        {/* 08/06 — Agrégats mensuel + annuel (demande user). */}
        <div className="mt-2 grid grid-cols-3 gap-2 text-center">
          <div className="rounded bg-gray-50 py-1">
            <div className="text-[10px] uppercase text-gray-400">Aujourd&apos;hui</div>
            <div className="text-sm font-semibold tabular-nums text-gray-800">${data.ledger.today_cost_usd.toFixed(2)}</div>
          </div>
          <div className="rounded bg-gray-50 py-1">
            <div className="text-[10px] uppercase text-gray-400">Ce mois ({data.ledger.month_label})</div>
            <div className="text-sm font-semibold tabular-nums text-gray-800">${data.ledger.month_cost_usd.toFixed(2)}</div>
          </div>
          <div className="rounded bg-gray-50 py-1">
            <div className="text-[10px] uppercase text-gray-400">Année ({data.ledger.year_label})</div>
            <div className="text-sm font-semibold tabular-nums text-gray-800">${data.ledger.year_cost_usd.toFixed(2)}</div>
          </div>
        </div>
        {data.ledger.today_cost_usd === 0 && data.ledger.last_date && (
          <p className="mt-1 text-[11px] text-gray-500">
            Dernière conso enregistrée : <span className="font-medium">{data.ledger.last_date}</span> — $
            {data.ledger.last_cost_usd.toFixed(2)}
            {Object.keys(data.ledger.last_by_model).length > 0 && (
              <>
                {' '}
                ({Object.entries(data.ledger.last_by_model)
                  .map(([m, c]) => `${m} $${Number(c).toFixed(2)}`)
                  .join(' · ')})
              </>
            )}
          </p>
        )}
        <p className="mt-1 text-[10px] text-gray-400">
          $0 aujourd&apos;hui = aucune dépense LLM (mode oversold déterministe). Le LLM
          n&apos;est pas « off » — cf. dernière conso ci-dessus.
        </p>
      </div>

      {/* Détail A/B shadow (framework gelé depuis 31/05 — informatif) */}
      {data.total_cost_usd > 0 && (
        <div className="mb-2 flex items-baseline justify-between text-xs text-gray-500">
          <span>Comparateur A/B (depuis {fmtSince})</span>
          <span>${data.total_cost_usd.toFixed(2)} · {data.total_cycles} cycles</span>
        </div>
      )}

      <div className="space-y-2">
        {Object.entries(data.providers).map(([key, p]) => {
          const meta = PROVIDER_LABELS[key] ?? { label: key, color: 'bg-gray-400' };
          // Mistral free tier : force display cost à 0. Évite confusion utilisateur
          // si le backend renvoie un coût théorique malgré MISTRAL_FREE_TIER=true.
          const isFreeTier = MISTRAL_FREE_TIER_BUCKETS.has(key);
          const displayCost = isFreeTier ? 0 : p.cost_usd;
          const pct = data.total_cost_usd > 0 ? (displayCost / data.total_cost_usd) * 100 : 0;
          return (
            <div key={key} className="flex items-center gap-3 text-xs">
              <div className={`h-2 w-2 rounded-full ${meta.color}`} aria-hidden />
              <span className="flex-1 font-medium text-gray-700">
                {meta.label}
                {isFreeTier && (
                  <span className="ml-1 text-[10px] text-green-600" title="Mistral en free tier (MISTRAL_FREE_TIER=true) — coût réel $0">
                    (free)
                  </span>
                )}
              </span>
              <span className="text-gray-500">{p.calls} calls</span>
              <span className="w-16 text-right font-mono text-gray-900">
                {isFreeTier ? '$0.000' : `$${displayCost.toFixed(3)}`}
              </span>
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
        Refresh 30s — headline = api_costs_daily (registre réel). Détail providers ci-dessus =
        comparateur A/B (gemini_ab_decisions + llm_ab_shadow_decisions), gelé depuis le retrait du gainers.
      </p>
    </div>
  );
}
