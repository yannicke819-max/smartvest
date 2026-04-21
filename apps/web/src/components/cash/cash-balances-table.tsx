'use client';

import type { CashBalanceRow } from '@/hooks/use-cash';

interface Props {
  balances: CashBalanceRow[];
}

function fmt(v: string) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return v;
  return n.toFixed(2);
}

export function CashBalancesTable({ balances }: Props) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Compte</th>
            <th className="px-3 py-2 font-medium">Devise</th>
            <th className="px-3 py-2 text-right font-medium">Settled</th>
            <th className="px-3 py-2 text-right font-medium">Réservé</th>
            <th className="px-3 py-2 text-right font-medium">Disponible</th>
            <th className="px-3 py-2 text-right font-medium">En transit</th>
            <th className="px-3 py-2 text-right font-medium">Mis à jour</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {balances.map((b) => (
            <tr key={b.id} className="hover:bg-muted/20">
              <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                {b.destination_id.slice(0, 8)}…
              </td>
              <td className="px-3 py-2 font-medium">{b.currency}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(b.settled)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-sky-700">{fmt(b.reserved)}</td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold text-emerald-700">
                {fmt(b.available)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-amber-700">
                {fmt(b.pending_in)}
              </td>
              <td className="px-3 py-2 text-right text-[11px] text-muted-foreground">
                {new Date(b.updated_at).toLocaleDateString('fr-FR')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
