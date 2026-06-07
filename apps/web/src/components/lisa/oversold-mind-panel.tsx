'use client';

import { Brain, AlertCircle } from 'lucide-react';
import { useOversoldMind } from '@/hooks/use-lisa';
import { SkeletonCard } from '@/components/ui/skeleton';

interface Props {
  portfolioId: string;
}

function fmtTime(iso: string): string {
  // timestamp Supabase peut être '...T03:15:22.72+00:00' ou '...Z'
  return iso.slice(11, 19);
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'à l\'instant';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h}h`;
  return `il y a ${Math.round(h / 24)}j`;
}

// Mapping kind → libellé + couleur. Couvre les décisions oversold (scan
// déterministe + sorties) tracées dans lisa_decision_log.
const KIND_LABELS: Record<string, { label: string; color: string }> = {
  oversold_scan_completed: { label: 'SCAN jour', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  oversold_intraday_scan_completed: { label: 'SCAN intraday', color: 'bg-teal-50 text-teal-700 border-teal-200' },
  oversold_scan_blocked_regime: { label: 'RÉGIME BLOQUÉ', color: 'bg-slate-100 text-slate-600 border-slate-300' },
  oversold_candidate_skip_news: { label: 'SKIP news', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  scanner_candidate_skip: { label: 'SKIP', color: 'bg-slate-50 text-slate-500 border-slate-200' },
  position_opened: { label: 'OPEN', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  position_closed: { label: 'CLOSE', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  position_closed_manual: { label: 'CLOSE manuel', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  mechanical_close_stop: { label: 'STOP', color: 'bg-red-50 text-red-700 border-red-200' },
  mechanical_close_target: { label: 'TAKE-PROFIT', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  choppy_exit_llm_approved: { label: 'EXIT validé', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  choppy_exit_llm_blocked: { label: 'EXIT bloqué', color: 'bg-slate-50 text-slate-500 border-slate-200' },
  risk_manager_thesis_broken: { label: 'THÈSE CASSÉE', color: 'bg-red-50 text-red-700 border-red-200' },
};

export function OversoldMindPanel({ portfolioId }: Props) {
  const { data, isLoading, error } = useOversoldMind(portfolioId, 30);

  return (
    <div className="rounded-lg border p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Esprit décision OVERSOLD</h2>
        <span className="text-xs text-muted-foreground">(30 dernières décisions · refresh 60s)</span>
      </div>

      {isLoading && <SkeletonCard />}

      {error && (
        <div className="text-xs text-red-600 flex items-center gap-1.5">
          <AlertCircle className="h-3 w-3" />
          Erreur chargement : {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {!isLoading && !error && (data?.length ?? 0) === 0 && (
        <div className="rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
          Aucune décision oversold pour l'instant (scan quotidien 21:15 UTC + intraday horaire).
        </div>
      )}

      {!isLoading && data && data.length > 0 && (
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {data.map((d) => {
            const spec = KIND_LABELS[d.kind] ?? {
              label: d.kind.toUpperCase(),
              color: 'bg-slate-50 text-slate-600 border-slate-200',
            };
            const pnl = d.pnl_usd;
            return (
              <div
                key={d.id}
                className="rounded-md border p-2.5 bg-card hover:bg-accent/30 transition-colors"
              >
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <span className="font-mono text-muted-foreground">{fmtTime(d.timestamp)}Z</span>
                  <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-medium ${spec.color}`}>
                    {spec.label}
                  </span>
                  {d.symbol && <span className="font-mono font-medium">{d.symbol}</span>}
                  {d.drop_pct != null && (
                    <span className="text-rose-600">drop {d.drop_pct.toFixed(1)}%</span>
                  )}
                  {d.candidates != null && d.opened != null && (
                    <span className="text-muted-foreground">{d.candidates} cand → {d.opened} ouverts</span>
                  )}
                  {pnl != null && (
                    <span className={`ml-auto font-medium ${pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                    </span>
                  )}
                </div>
                {d.summary && (
                  <div className="mt-1.5 text-xs">{d.summary}</div>
                )}
                {d.rationale && (
                  <div className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">
                    💭 {d.rationale}
                  </div>
                )}
                <div className="mt-1 text-[10px] text-muted-foreground/70">{relativeAge(d.timestamp)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
