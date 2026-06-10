'use client';

import { Brain } from 'lucide-react';
import { useCloseDecisions, type CloseDecisionRow } from '@/hooks/use-close-decisions';

/**
 * CloseDecisionsPanel — vue d'inspection de l'imitation learning.
 *
 * Liste les décisions de close labellisées (position_close_decisions) : pour
 * chaque close, le verdict +60min (GOOD/EARLY/OK, horizon gainers) ET le verdict
 * à l'échéance J+10 (CLOSE_BETTER / HELD_BETTER / NEUTRAL = aurais-tu mieux fait
 * de tenir ?), avec contexte (danger-zone / oversold-early) + news. Observation
 * pure — base du futur LLM qui apprendra QUAND fermer.
 */
export function CloseDecisionsPanel({ portfolioId }: { portfolioId: string }) {
  const { data, isLoading, isError } = useCloseDecisions(portfolioId);

  if (isLoading) {
    return <div className="rounded-lg border p-4 text-sm text-muted-foreground">🧠 Chargement des décisions de close…</div>;
  }
  if (isError || !data) {
    return <div className="rounded-lg border p-4 text-sm text-muted-foreground">🧠 Décisions de close indisponibles.</div>;
  }

  const s = data.summary;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-purple-600" />
          <h2 className="text-sm font-medium">🧠 Décisions de close (apprentissage)</h2>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {s.total} closes{s.total > 10 ? ' · défilez pour voir les plus anciens' : ''}
        </span>
      </div>

      {s.total > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <Stat label="Bien sortis (60m)" value={s.good60m} cls="text-emerald-600" />
          <Stat label="Trop tôt (60m)" value={s.early60m} cls="text-amber-600" />
          <Stat label="Tenir mieux (J+10)" value={s.heldBetter} cls="text-rose-500" />
          <Stat label="Close OK (J+10)" value={s.closeBetter} cls="text-emerald-600" />
        </div>
      )}

      {data.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          Aucune décision de close enregistrée pour l&apos;instant. Chaque fermeture (manuelle ou auto)
          alimente cette table ; les verdicts se peuplent à +60min puis à l&apos;échéance J+10.
        </p>
      ) : (
        <div className="overflow-x-auto overflow-y-auto max-h-80">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-background z-10">
              <tr className="text-left text-muted-foreground border-b">
                <th className="py-1.5 pr-2">Symbole</th>
                <th className="py-1.5 px-2">Contexte</th>
                <th className="py-1.5 px-2">Sortie</th>
                <th className="py-1.5 px-2 text-right">P&amp;L close</th>
                <th className="py-1.5 px-2">Verdict 60m</th>
                <th className="py-1.5 px-2" title="Le checkpoint J+N où tenir aurait le mieux payé. Survolez pour la trajectoire J+1/J+3/J+6/J+10.">Meilleur jour</th>
                <th className="py-1.5 px-2">Verdict J+10</th>
                <th className="py-1.5 pl-2 text-right">News</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <Row key={r.id} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground italic">
        « Trop tôt » = le prix a continué favorablement +60min après ta sortie. « Tenir mieux » = tenir
        jusqu&apos;à J+10 aurait battu ta sortie. <strong>Meilleur jour</strong> = le checkpoint J+N (J+1/J+3/J+6/J+10,
        survol pour le détail) où tenir aurait le mieux payé — il se peuple au fil des jours, sans attendre J+10.
        C&apos;est la matière brute de l&apos;imitation learning : le LLM apprendra à reproduire tes
        <strong> bonnes</strong> sorties, pas toutes.
      </p>
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: number; cls?: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${cls ?? ''}`}>{value}</div>
    </div>
  );
}

const CONTEXT_LABEL: Record<string, string> = {
  danger_zone: '🚨 danger-zone',
  oversold_early: '📉 oversold',
  manual_other: 'manuel',
};

function Badge60m({ v }: { v: string | null }) {
  if (v === 'GOOD') return <span className="text-emerald-600">🟢 bien sorti</span>;
  if (v === 'EARLY') return <span className="text-amber-600">🟡 trop tôt</span>;
  if (v === 'OK') return <span className="text-muted-foreground">⚪ neutre</span>;
  return <span className="text-muted-foreground">—</span>;
}

function BadgeDeadline({ v, pnlIfHeld }: { v: string | null; pnlIfHeld: number | null }) {
  const held = pnlIfHeld != null ? ` (tenu ${pnlIfHeld >= 0 ? '+' : ''}${pnlIfHeld.toFixed(1)}%)` : '';
  if (v === 'CLOSE_BETTER') return <span className="text-emerald-600">🟢 close OK{held}</span>;
  if (v === 'HELD_BETTER') return <span className="text-rose-500">🔴 tenir mieux{held}</span>;
  if (v === 'NEUTRAL') return <span className="text-muted-foreground">⚪ neutre{held}</span>;
  return <span className="text-muted-foreground" title="Se peuplera à l'échéance J+10">⏳</span>;
}

/**
 * Meilleur jour = le checkpoint J+N de la trajectoire où tenir aurait le mieux
 * payé (P&L-si-tenu max). Se peuple progressivement (J+1 → J+3 → J+6 → J+10).
 * Le survol montre la trajectoire complète des checkpoints écoulés.
 */
function BestDayCell({ r }: { r: CloseDecisionRow }) {
  const traj = r.trajectory ?? [];
  if (traj.length === 0 || r.bestDayLabel == null) {
    return (
      <span className="text-muted-foreground" title="Se peuple à J+1, J+3, J+6 puis J+10 (le prix EOD doit d'abord publier)">
        ⏳ en cours
      </span>
    );
  }
  const pnl = r.bestDayPnlPct;
  const cls = pnl == null ? 'text-muted-foreground' : pnl > 0 ? 'text-emerald-600' : pnl < 0 ? 'text-rose-500' : 'text-muted-foreground';
  const tip = traj
    .map((t) => `J+${t.d} ${t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(1)}%` : '—'}`)
    .join('  ·  ');
  return (
    <span className={`tabular-nums ${cls}`} title={`Trajectoire (P&L si tenu) : ${tip}`}>
      🏆 {r.bestDayLabel} {pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%` : ''}
    </span>
  );
}

function Row({ r }: { r: CloseDecisionRow }) {
  const pnlCls = r.pnlPct == null ? 'text-muted-foreground' : r.pnlPct >= 0 ? 'text-emerald-600' : 'text-rose-500';
  return (
    <tr className="border-b last:border-0">
      <td className="py-1.5 pr-2 font-medium">{r.symbol.replace('.US', '')}</td>
      <td className="py-1.5 px-2 text-muted-foreground whitespace-nowrap">{CONTEXT_LABEL[r.context ?? ''] ?? (r.context ?? '—')}</td>
      <td className="py-1.5 px-2 tabular-nums text-muted-foreground whitespace-nowrap">
        {new Date(r.closedAt).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
      </td>
      <td className={`py-1.5 px-2 text-right tabular-nums ${pnlCls}`}>
        {r.pnlPct != null ? `${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(2)}%` : '—'}
      </td>
      <td className="py-1.5 px-2 whitespace-nowrap"><Badge60m v={r.verdict60m} /></td>
      <td className="py-1.5 px-2 whitespace-nowrap"><BestDayCell r={r} /></td>
      <td className="py-1.5 px-2 whitespace-nowrap"><BadgeDeadline v={r.deadlineVerdict} pnlIfHeld={r.pnlIfHeldToDeadlinePct} /></td>
      <td className="py-1.5 pl-2 text-right tabular-nums text-muted-foreground">
        {r.newsCount != null && r.newsCount > 0
          ? `${r.newsCount}${r.newsMinSentiment != null ? ` · ${r.newsMinSentiment.toFixed(2)}` : ''}`
          : '—'}
      </td>
    </tr>
  );
}
