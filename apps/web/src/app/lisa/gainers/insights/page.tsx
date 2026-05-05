'use client';

/**
 * PR #6 — Dashboard auto-learning Gainers.
 *
 * 4 panels :
 *   1. ML Model State — empirical law + AUC + accuracy + sample_size
 *   2. Drift Events — last 30 days from gainers_insights_log
 *   3. AutoTuner History — ajustements appliqués pour le portfolio
 *   4. Threshold Proposals — type='threshold_proposal' insights (suggestions)
 *
 * Page user-facing (pas admin token requis).
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, Brain, Activity, Sliders, Lightbulb } from 'lucide-react';
import { usePortfolios } from '@/hooks/use-portfolio';
import {
  usePersistenceEmpiricalLaw,
  useGainersInsights,
  useAutoTunerHistory,
  type GainersInsightRow,
  type AutoTunerHistoryRow,
} from '@/hooks/use-operating-mode';

export default function GainersInsightsPage() {
  const portfoliosQuery = usePortfolios();
  const portfolios = (portfoliosQuery.data ?? []).filter(
    (p) => (p as { is_simulation?: boolean }).is_simulation === true,
  );
  const [portfolioId, setPortfolioId] = useState<string | null>(null);

  useEffect(() => {
    if (!portfolioId && portfolios[0]?.id) setPortfolioId(portfolios[0].id);
  }, [portfolios, portfolioId]);

  const empiricalLaw = usePersistenceEmpiricalLaw({ lookbackDays: 30, minSample: 20 });
  const driftInsights = useGainersInsights({ sinceDays: 30, limit: 50, type: 'cadence_drift' });
  const thresholdProposals = useGainersInsights({ sinceDays: 30, limit: 50, type: 'threshold_proposal' });
  const autoTunerHistory = useAutoTunerHistory(portfolioId, 50);

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-6xl">
      <div className="flex items-center gap-3">
        <Link
          href="/lisa"
          className="text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          Retour
        </Link>
        <h1 className="text-2xl font-bold">Auto-learning · Gainers</h1>
      </div>

      <p className="text-sm text-zinc-400">
        Visualisation de la boucle d&apos;apprentissage : modèle ML logistique
        (P9), détecteurs de drift, AutoTuner Phase C, et historique des
        ajustements appliqués.
      </p>

      {portfolios.length > 0 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-zinc-400">Portfolio :</span>
          <select
            value={portfolioId ?? ''}
            onChange={(e) => setPortfolioId(e.target.value || null)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Panel 1 : ML Model State */}
      <Panel
        icon={<Brain className="w-4 h-4" />}
        title="Modèle ML — Probability of Win (logistic regression)"
      >
        {empiricalLaw.isLoading ? (
          <p className="text-xs text-zinc-400">Chargement…</p>
        ) : empiricalLaw.data ? (
          <>
            <div className="grid grid-cols-4 gap-3 mb-4">
              <Metric label="Version modèle" value={empiricalLaw.data.modelVersion ?? '—'} />
              <Metric label="AUC ROC" value={empiricalLaw.data.aucRoc != null ? empiricalLaw.data.aucRoc.toFixed(3) : '—'} hint={empiricalLaw.data.aucRoc != null && empiricalLaw.data.aucRoc < 0.55 ? '⚠ <0.55' : ''} />
              <Metric label="Accuracy" value={empiricalLaw.data.accuracy != null ? empiricalLaw.data.accuracy.toFixed(3) : '—'} />
              <Metric label="Trades trainés" value={String(empiricalLaw.data.trainedOn)} hint={empiricalLaw.data.fallback ? '⚠ Fallback' : 'Production'} />
            </div>
            {empiricalLaw.data.empiricalLaw.length > 0 && (
              <table className="w-full text-xs border-t">
                <thead className="text-zinc-400">
                  <tr>
                    <th className="text-left py-1">Bucket persistence</th>
                    <th className="text-right py-1">N</th>
                    <th className="text-right py-1">P(win)</th>
                    <th className="text-right py-1">Avg PnL %</th>
                    <th className="text-right py-1">CI 95%</th>
                  </tr>
                </thead>
                <tbody>
                  {empiricalLaw.data.empiricalLaw.map((row, i) => (
                    <tr key={i} className="border-t border-zinc-800">
                      <td className="py-1 font-mono">{row.persistenceCount}</td>
                      <td className="py-1 text-right">{row.n}</td>
                      <td className="py-1 text-right">{row.pWinObserved != null ? (row.pWinObserved * 100).toFixed(1) + '%' : '—'}</td>
                      <td className="py-1 text-right">{row.avgPnlPct != null ? row.avgPnlPct.toFixed(2) : '—'}</td>
                      <td className="py-1 text-right text-zinc-500">
                        {row.ciLow != null && row.ciHigh != null ? `[${(row.ciLow * 100).toFixed(0)}%, ${(row.ciHigh * 100).toFixed(0)}%]` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <p className="text-xs text-red-400">Échec chargement loi empirique.</p>
        )}
      </Panel>

      {/* Panel 2 : Drift Events */}
      <Panel
        icon={<Activity className="w-4 h-4" />}
        title="Drift detector — événements 30 jours"
      >
        <InsightsList insights={driftInsights.data?.insights ?? []} loading={driftInsights.isLoading} emptyMessage="Aucun drift détecté sur les 30 derniers jours." />
      </Panel>

      {/* Panel 3 : Threshold proposals */}
      <Panel
        icon={<Lightbulb className="w-4 h-4" />}
        title="Suggestions AutoTuner — Phase C"
      >
        <InsightsList insights={thresholdProposals.data?.insights ?? []} loading={thresholdProposals.isLoading} emptyMessage="Aucune suggestion d'ajustement de seuils sur les 30 derniers jours." />
      </Panel>

      {/* Panel 4 : Auto-tuner history per portfolio */}
      <Panel
        icon={<Sliders className="w-4 h-4" />}
        title="Historique des ajustements appliqués"
      >
        <AutoTunerHistoryTable rows={autoTunerHistory.data?.history ?? []} loading={autoTunerHistory.isLoading} />
      </Panel>
    </div>
  );
}

function Panel({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-center gap-2 mb-4 text-sm font-semibold">
        {icon}
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-zinc-900/60 p-3 border border-zinc-800">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-lg font-mono">{value}</div>
      {hint && <div className="text-[10px] text-zinc-400 mt-1">{hint}</div>}
    </div>
  );
}

function InsightsList({
  insights,
  loading,
  emptyMessage,
}: {
  insights: GainersInsightRow[];
  loading: boolean;
  emptyMessage: string;
}) {
  if (loading) return <p className="text-xs text-zinc-400">Chargement…</p>;
  if (insights.length === 0) return <p className="text-xs text-zinc-400">{emptyMessage}</p>;
  return (
    <ul className="space-y-2">
      {insights.map((row) => (
        <li key={row.id} className="border-l-2 border-zinc-700 pl-3 py-1">
          <div className="flex items-baseline gap-2">
            <span className={`text-[10px] uppercase font-medium ${
              row.severity === 'critical' ? 'text-red-400' :
              row.severity === 'high' ? 'text-orange-400' :
              row.severity === 'medium' ? 'text-yellow-400' :
              'text-zinc-500'
            }`}>
              {row.severity}
            </span>
            <span className="text-[10px] text-zinc-500">{new Date(row.created_at).toLocaleString()}</span>
            <span className="text-[10px] text-zinc-500">· {row.source}</span>
          </div>
          <div className="text-sm text-zinc-200 mt-0.5">{row.summary}</div>
        </li>
      ))}
    </ul>
  );
}

function AutoTunerHistoryTable({
  rows,
  loading,
}: {
  rows: AutoTunerHistoryRow[];
  loading: boolean;
}) {
  if (loading) return <p className="text-xs text-zinc-400">Chargement…</p>;
  if (rows.length === 0) {
    return (
      <p className="text-xs text-zinc-400">
        Aucun ajustement appliqué pour ce portfolio. Active l&apos;AutoTuner dans
        la configuration Gainers (env=shadow par défaut, log only).
      </p>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead className="text-zinc-400">
        <tr className="border-b">
          <th className="text-left py-1">Date</th>
          <th className="text-left py-1">Seuil</th>
          <th className="text-right py-1">Ancien</th>
          <th className="text-right py-1">Nouveau</th>
          <th className="text-left py-1">Raison</th>
          <th className="text-right py-1">N</th>
          <th className="text-left py-1">Env</th>
          <th className="text-left py-1">Mode</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-b border-zinc-800">
            <td className="py-1 text-zinc-500">{new Date(row.applied_at).toLocaleDateString()}</td>
            <td className="py-1 font-mono">{row.threshold_name.replace('gainers_', '')}</td>
            <td className="py-1 text-right">{Number(row.old_value).toFixed(3)}</td>
            <td className="py-1 text-right">
              <span className={Number(row.new_value) > Number(row.old_value) ? 'text-red-400' : 'text-emerald-400'}>
                {Number(row.new_value).toFixed(3)}
              </span>
            </td>
            <td className="py-1 text-zinc-500">{row.reason}</td>
            <td className="py-1 text-right">{row.sample_size}</td>
            <td className="py-1">
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                row.applied_to_env === 'prod' ? 'bg-red-900/30 text-red-300' :
                row.applied_to_env === 'canary' ? 'bg-yellow-900/30 text-yellow-300' :
                'bg-zinc-800 text-zinc-400'
              }`}>{row.applied_to_env}</span>
            </td>
            <td className="py-1 text-zinc-500">{row.auto_or_manual}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
