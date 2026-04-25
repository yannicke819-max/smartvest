'use client';

import { useLisaOptions, type LisaOptionPosition } from '@/hooks/use-lisa';

/**
 * Affiche les positions options ouvertes (long calls / puts) avec mark
 * Black-Scholes en temps réel. Refresh auto toutes les 30s.
 */
export function OptionPositionsCard({ portfolioId }: { portfolioId: string | null }) {
  const query = useLisaOptions(portfolioId);
  const opens = query.data ?? [];

  if (!portfolioId || query.isLoading) return null;
  if (opens.length === 0) {
    return (
      <div className="rounded-lg border p-5">
        <h2 className="font-medium">Options ouvertes</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Aucune position option ouverte. Lisa propose des options sur conviction ≥ 8/10
          quand tu actives le flag <code>enable_derivatives</code> dans la config.
        </p>
      </div>
    );
  }

  const totalValue = opens.reduce((s, o) => s + o.current_value_usd, 0);
  const totalPnl = opens.reduce((s, o) => s + o.pnl_usd, 0);
  const totalPremium = opens.reduce((s, o) => s + o.premium_paid_usd, 0);

  return (
    <div className="rounded-lg border p-5 space-y-3">
      <div className="flex justify-between items-baseline">
        <h2 className="font-medium">Options ouvertes ({opens.length})</h2>
        <div className="text-xs text-muted-foreground">
          Premium total : ${totalPremium.toFixed(0)} | Valeur :{' '}
          <span className={totalPnl >= 0 ? 'text-emerald-600' : 'text-red-600'}>
            ${totalValue.toFixed(0)} ({totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(0)})
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="text-left py-1">Type</th>
              <th className="text-left py-1">Sous-jacent</th>
              <th className="text-right py-1">Strike</th>
              <th className="text-right py-1">Spot</th>
              <th className="text-left py-1">Expiry</th>
              <th className="text-right py-1">Contrats</th>
              <th className="text-right py-1">Premium</th>
              <th className="text-right py-1">Valeur</th>
              <th className="text-right py-1">P&amp;L $</th>
              <th className="text-right py-1">P&amp;L %</th>
              <th className="text-right py-1">Delta</th>
              <th className="text-right py-1">Conv.</th>
            </tr>
          </thead>
          <tbody>
            {opens.map((o) => (
              <OptionRow key={o.id} o={o} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Mark-to-market via Black-Scholes (IV figée à l'ouverture). Cron 5 min ferme
        automatiquement à expiration ou take-profit ×2 premium.
      </p>
    </div>
  );
}

function OptionRow({ o }: { o: LisaOptionPosition }) {
  const profitable = o.pnl_usd >= 0;
  const itm =
    o.kind === 'call' ? o.current_underlying > o.strike : o.current_underlying < o.strike;
  return (
    <tr className="border-b last:border-0">
      <td className="py-1 font-mono">
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
            o.kind === 'call'
              ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
              : 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300'
          }`}
        >
          {o.kind.toUpperCase()}
        </span>
        {itm && <span className="ml-1 text-[10px] text-amber-600 font-medium">ITM</span>}
      </td>
      <td className="py-1 font-mono">{o.underlying}</td>
      <td className="py-1 text-right font-mono">{o.strike.toFixed(2)}</td>
      <td className="py-1 text-right font-mono">{o.current_underlying.toFixed(2)}</td>
      <td className="py-1 text-xs">{o.expiry}</td>
      <td className="py-1 text-right">{o.contracts}</td>
      <td className="py-1 text-right">${o.premium_paid_usd.toFixed(0)}</td>
      <td className="py-1 text-right">${o.current_value_usd.toFixed(0)}</td>
      <td className={`py-1 text-right ${profitable ? 'text-emerald-600' : 'text-red-600'}`}>
        {profitable ? '+' : ''}${o.pnl_usd.toFixed(2)}
      </td>
      <td className={`py-1 text-right ${profitable ? 'text-emerald-600' : 'text-red-600'}`}>
        {profitable ? '+' : ''}{o.pnl_pct.toFixed(2)}%
      </td>
      <td className="py-1 text-right text-muted-foreground">{o.delta.toFixed(2)}</td>
      <td className="py-1 text-right">{o.conviction_score?.toFixed(1) ?? '—'}</td>
    </tr>
  );
}
