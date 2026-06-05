'use client';

import { Brain, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { useTraderMind } from '@/hooks/use-lisa';
import { SkeletonCard } from '@/components/ui/skeleton';

interface Props {
  portfolioId: string;
}

function fmtTime(iso: string): string {
  return iso.slice(11, 19);
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'à l\'instant';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  return `il y a ${h}h`;
}

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  open_directional: { label: 'OPEN', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  scale_in: { label: 'SCALE IN', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  close: { label: 'CLOSE', color: 'bg-red-50 text-red-700 border-red-200' },
  trail_stop: { label: 'TRAIL SL', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  hold: { label: 'HOLD', color: 'bg-slate-50 text-slate-600 border-slate-200' },
};

export function TraderMindPanel({ portfolioId }: Props) {
  const { data, isLoading, error } = useTraderMind(portfolioId, 30);

  return (
    <div className="rounded-lg border p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Esprit décision TRADER</h2>
        <span className="text-xs text-muted-foreground">(30 derniers cycles · refresh 60s)</span>
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
          Aucune décision pour l'instant.
        </div>
      )}

      {!isLoading && data && data.length > 0 && (
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {data.map((d) => {
            const spec = ACTION_LABELS[d.action_kind ?? ''] ?? { label: (d.action_kind ?? '?').toUpperCase(), color: 'bg-slate-50 text-slate-600 border-slate-200' };
            const applied = d.action_applied === true;
            const isBypass = (d.thesis ?? '').includes('TRADER_BYPASS_HIGH_CONVICTION');
            return (
              <div
                key={d.id}
                className="rounded-md border p-2.5 bg-card hover:bg-accent/30 transition-colors"
              >
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <span className="font-mono text-muted-foreground">{fmtTime(d.decided_at)}Z</span>
                  {applied ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-slate-400" />
                  )}
                  <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-medium ${spec.color}`}>
                    {spec.label}
                  </span>
                  {d.target_symbol && (
                    <span className="font-mono font-medium">{d.target_symbol}</span>
                  )}
                  {d.direction && (
                    <span className="text-muted-foreground uppercase">{d.direction}</span>
                  )}
                  {d.confidence != null && (
                    <span className="text-muted-foreground">conf={Number(d.confidence).toFixed(2)}</span>
                  )}
                  {d.notional_usd && (
                    <span className="text-muted-foreground">${Number(d.notional_usd).toFixed(0)}</span>
                  )}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {isBypass ? '⚡ bypass' : d.llm_provider ?? '—'} · ${d.total_cost_usd.toFixed(4)}
                  </span>
                </div>
                {d.thesis && (
                  <div className="mt-1.5 text-xs text-muted-foreground line-clamp-2">
                    💭 {d.thesis}
                  </div>
                )}
                {d.apply_error && (
                  <div className="mt-1 text-[10px] text-red-600 line-clamp-1">
                    ⚠ {d.apply_error}
                  </div>
                )}
                <div className="mt-1 text-[10px] text-muted-foreground/70">{relativeAge(d.decided_at)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
