/**
 * Panel UI "Audit auto-apprentissage" — bouton qui lance les 8 checks
 * Supabase et affiche le résultat. Réutilise l'endpoint admin
 * /admin/verify-learning-loop (qui réutilise la même logique que le
 * script CLI `pnpm verify:learning-loop`).
 *
 * Affichage en cartes par check avec badge OK/WARN/KO/INFO.
 */
'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';

type CheckStatus = 'OK' | 'WARN' | 'KO' | 'INFO';

interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  data?: Record<string, unknown>;
}

interface AuditReport {
  generated_at: string;
  trader_portfolio_id: string;
  global_status: CheckStatus;
  checks: CheckResult[];
  latency_ms: number;
}

const STATUS_CONFIG: Record<CheckStatus, { color: string; bg: string; emoji: string; label: string }> = {
  OK:   { color: 'text-green-700',  bg: 'bg-green-50 border-green-200',   emoji: '✅', label: 'OK' },
  WARN: { color: 'text-yellow-800', bg: 'bg-yellow-50 border-yellow-200', emoji: '⚠️',  label: 'WARN' },
  KO:   { color: 'text-red-700',    bg: 'bg-red-50 border-red-200',       emoji: '❌', label: 'KO' },
  INFO: { color: 'text-cyan-700',   bg: 'bg-cyan-50 border-cyan-200',     emoji: 'ℹ️',  label: 'INFO' },
};

export function LearningLoopAuditPanel() {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAudit = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<AuditReport>('/admin/verify-learning-loop');
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">🧠 Audit boucle d&apos;auto-apprentissage</h3>
          <p className="text-[11px] text-muted-foreground">
            8 checks Supabase (citations, proposals, advisories, lessons, decisions). Réplique du script
            CLI <code className="rounded bg-gray-100 px-1">pnpm verify:learning-loop</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={runAudit}
          disabled={loading}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? '⏳ Audit en cours…' : '🔄 Relancer audit'}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          Erreur : {error}
        </div>
      )}

      {report && (
        <>
          <div className={`mb-3 rounded border p-3 ${STATUS_CONFIG[report.global_status].bg}`}>
            <div className="flex items-center justify-between">
              <span className={`text-sm font-bold ${STATUS_CONFIG[report.global_status].color}`}>
                {STATUS_CONFIG[report.global_status].emoji} Global : {STATUS_CONFIG[report.global_status].label}
              </span>
              <span className="text-[11px] text-gray-500">
                {new Date(report.generated_at).toISOString().slice(11, 19)} UTC · {report.latency_ms}ms
              </span>
            </div>
          </div>

          <div className="space-y-2">
            {report.checks.map((check) => {
              const cfg = STATUS_CONFIG[check.status];
              return (
                <div key={check.id} className={`rounded border px-3 py-2 text-xs ${cfg.bg}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`font-semibold ${cfg.color}`}>
                      {cfg.emoji} {check.title}
                    </span>
                    <span className={`text-[10px] font-mono ${cfg.color}`}>{cfg.label}</span>
                  </div>
                  <div className="mt-1 text-gray-600">{check.detail}</div>
                  {check.data && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[10px] text-gray-500 hover:text-gray-700">data</summary>
                      <pre className="mt-1 overflow-x-auto rounded bg-white/60 p-1 text-[10px] text-gray-700">
                        {JSON.stringify(check.data, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {!report && !loading && !error && (
        <p className="text-xs text-gray-500">
          Clique sur <strong>Relancer audit</strong> pour mesurer l&apos;état actuel des 8 indicateurs clés.
        </p>
      )}
    </div>
  );
}
