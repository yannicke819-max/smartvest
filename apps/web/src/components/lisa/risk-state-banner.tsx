'use client';

import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, ShieldAlert } from 'lucide-react';
import { useRiskState, type SanityRow } from '@/hooks/use-risk-state';

/**
 * PR #338 — bandeau état de risque pour la page /lisa et /lisa/parameters.
 *
 * - bandeau rouge sticky si circuit breaker actif (lisa_circuit_breaker_state)
 * - bandeau orange si sanity rejections sur 24h (lisa_sanity_rejections)
 * - badges feature flags Fly (read-only) avec tooltip toggle CLI
 *
 * Polling 30s côté hook. Composant rend null si aucune donnée (pas de bandeau bruyant).
 */

function fmtRelative(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `il y a ${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `il y a ${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `il y a ${Math.round(ms / 3_600_000)} h`;
  return `il y a ${Math.round(ms / 86_400_000)} j`;
}

export function RiskStateBanner({ portfolioId }: { portfolioId: string | null }) {
  const [showDetails, setShowDetails] = useState(false);
  const q = useRiskState(portfolioId);

  if (!portfolioId || !q.data) return null;

  const { circuit_breaker: cb, sanity_rejections: sanity } = q.data;
  const hasAnyAlert = cb.is_tripped || sanity.count_24h > 0;

  return (
    <div className="space-y-2">
      {cb.is_tripped && (
        <div className="rounded-lg border-2 border-red-500 bg-red-50 dark:bg-red-950/30 p-4">
          <div className="flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold text-red-700 dark:text-red-400">
                Circuit breaker déclenché : {cb.reason ?? 'raison inconnue'}
              </div>
              <div className="text-sm text-red-700/80 dark:text-red-400/80 mt-1">
                Déclenchement {fmtRelative(cb.triggered_at)} ·
                {cb.pnl_at_trigger != null && ` PnL ${cb.pnl_at_trigger.toFixed(2)} USD · `}
                {cb.positions_open_at_trigger != null &&
                  `${cb.positions_open_at_trigger} positions ouvertes au moment du trip`}
              </div>
              {cb.notes && (
                <div className="text-xs text-red-700/70 dark:text-red-400/70 mt-1 italic">{cb.notes}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {sanity.count_24h > 0 && (
        <div className="rounded-lg border border-amber-500 bg-amber-50 dark:bg-amber-950/30 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-medium text-amber-700 dark:text-amber-500">
                  {sanity.count_24h} anomalie{sanity.count_24h > 1 ? 's' : ''} prix bloquée
                  {sanity.count_24h > 1 ? 's' : ''} sur 24 h (R5 sanity)
                </div>
                <div className="text-sm text-amber-700/80 dark:text-amber-500/80 mt-1">
                  Ces fermetures de positions ont été refusées car le prix d'exit était aberrant
                  (exit_price ≤ 0 ou ratio &lt; 50 % entry ou pnl_pct &lt; -50 %).
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="text-xs text-amber-700 dark:text-amber-400 hover:underline flex items-center gap-1"
            >
              {showDetails ? 'Masquer' : 'Voir détails'}
              {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
          </div>
          {showDetails && sanity.recent.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-amber-200 dark:border-amber-900">
                  <tr>
                    <th className="px-2 py-1 text-left">Symbole</th>
                    <th className="px-2 py-1 text-left">Classe</th>
                    <th className="px-2 py-1 text-right">Exit price</th>
                    <th className="px-2 py-1 text-right">PnL %</th>
                    <th className="px-2 py-1 text-left">Raison</th>
                    <th className="px-2 py-1 text-left">Rejeté</th>
                  </tr>
                </thead>
                <tbody>
                  {sanity.recent.map((r: SanityRow) => (
                    <tr key={r.id} className="border-b border-amber-100 dark:border-amber-900/50">
                      <td className="px-2 py-1 font-mono">{r.symbol}</td>
                      <td className="px-2 py-1 text-muted-foreground">{r.asset_class ?? '—'}</td>
                      <td className="px-2 py-1 text-right">
                        {r.raw_exit_price != null ? r.raw_exit_price.toFixed(4) : '—'}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {r.raw_pnl_pct != null ? `${r.raw_pnl_pct.toFixed(2)} %` : '—'}
                      </td>
                      <td className="px-2 py-1">{r.raison}</td>
                      <td className="px-2 py-1 text-muted-foreground">{fmtRelative(r.rejected_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 07/06 — Badges « Flags Fly (read-only) » (QUICK_WINS_PIPELINE_ENABLED,
          GAINERS_NSE_BLACKLIST_ENABLED) masqués définitivement (demande user) :
          flags gainers de debug sans intérêt pour l'utilisateur, pollution visuelle.
          Les valeurs restent lisibles côté admin (/admin/config-dump) si besoin. */}

      {!hasAnyAlert && (
        <div className="text-xs text-muted-foreground italic">
          Aucune alerte de risque active. Circuit breaker resté inactif, aucune anomalie prix sur 24 h.
        </div>
      )}
    </div>
  );
}
