'use client';

import { useQuickWinsRecent, useQuickWinsStats } from '@/hooks/use-quick-wins-stats';

/**
 * PR #338 — dashboard activité des Quick Wins (table qw_decision_log, migration 0140).
 *
 * Section 1 : stats agrégées 24h par qw_id (total / pass / block / modify / pct_block / shadow).
 * Section 2 : 50 dernières décisions individuelles (table déroulante).
 *
 * Les QW attendus pour le pipeline complet :
 *   QW_1 / QW_4 / QW_6 / QW_9 / QW_11 / QW_15 / QW_17 / QW_18 / QW_27 / QW_46 / QW_47
 *   + CIRCUIT_BREAKER pré-cascade
 * Si une QW n'a aucune ligne 24h, on l'affiche en gris "Inactif" (drapeau désactivé
 * ou aucune décision dans la fenêtre).
 */

const EXPECTED_QWS = [
  'CIRCUIT_BREAKER',
  'QW_1',
  'QW_4',
  'QW_6',
  'QW_9',
  'QW_11',
  'QW_14A',
  'QW_15',
  'QW_17',
  'QW_18',
  'QW_27',
  'QW_46',
  'QW_47',
];

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} j`;
}

function decisionBadge(d: string): string {
  if (d === 'block') return 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 border-red-500';
  if (d === 'modify') return 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-500 border-amber-500';
  return 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 border-emerald-500';
}

export function QuickWinsActivityPanel() {
  const statsQ = useQuickWinsStats();
  const recentQ = useQuickWinsRecent(50);

  const stats = statsQ.data ?? [];
  const recent = recentQ.data ?? [];

  const byQw = new Map(stats.map((s) => [s.qw_id, s]));

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="bg-muted/50 border-b px-3 py-2 text-sm font-medium">
          Stats 24h par Quick Win
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 border-b">
              <tr>
                <th className="px-3 py-2 text-left font-medium">QW ID</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 text-right font-medium">Pass</th>
                <th className="px-3 py-2 text-right font-medium">Block</th>
                <th className="px-3 py-2 text-right font-medium">Modify</th>
                <th className="px-3 py-2 text-right font-medium">% Block</th>
                <th className="px-3 py-2 text-right font-medium">Shadow (auraient passé)</th>
              </tr>
            </thead>
            <tbody>
              {EXPECTED_QWS.map((qwId) => {
                const row = byQw.get(qwId);
                if (!row) {
                  return (
                    <tr key={qwId} className="border-b last:border-b-0 text-muted-foreground italic">
                      <td className="px-3 py-2 font-mono text-xs">{qwId}</td>
                      <td colSpan={6} className="px-3 py-2 text-xs">
                        Inactif (aucune décision 24h)
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={qwId} className="border-b last:border-b-0">
                    <td className="px-3 py-2 font-mono text-xs">{qwId}</td>
                    <td className="px-3 py-2 text-right">{row.total}</td>
                    <td className="px-3 py-2 text-right text-emerald-700 dark:text-emerald-400">
                      {row.pass}
                    </td>
                    <td className="px-3 py-2 text-right text-red-700 dark:text-red-400">{row.block}</td>
                    <td className="px-3 py-2 text-right text-amber-700 dark:text-amber-500">
                      {row.modify}
                    </td>
                    <td className="px-3 py-2 text-right">{row.pct_block.toFixed(1)} %</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {row.shadow_would_have_passed}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {statsQ.isError && (
          <div className="px-3 py-2 text-xs text-red-600 border-t bg-red-50 dark:bg-red-950/20">
            Erreur de chargement stats : {String(statsQ.error)}
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="bg-muted/50 border-b px-3 py-2 text-sm font-medium">
          50 dernières décisions
        </div>
        <div className="overflow-y-auto max-h-96">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 border-b sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">QW</th>
                <th className="px-3 py-2 text-left font-medium">Symbole</th>
                <th className="px-3 py-2 text-left font-medium">Classe</th>
                <th className="px-3 py-2 text-left font-medium">Décision</th>
                <th className="px-3 py-2 text-left font-medium">Raison</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground text-xs italic">
                    Aucune décision récente.
                  </td>
                </tr>
              )}
              {recent.map((row) => (
                <tr key={row.id} className="border-b last:border-b-0">
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {fmtRelative(row.created_at)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{row.qw_id}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.symbol}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{row.asset_class}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded border px-2 py-0.5 text-xs ${decisionBadge(row.decision)}`}
                    >
                      {row.decision}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {recentQ.isError && (
          <div className="px-3 py-2 text-xs text-red-600 border-t bg-red-50 dark:bg-red-950/20">
            Erreur de chargement décisions : {String(recentQ.error)}
          </div>
        )}
      </div>
    </div>
  );
}
