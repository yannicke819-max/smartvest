'use client';


import type { LisaSnapshot } from '@/hooks/use-lisa';
import { KpiCard } from '@/components/kpi-card';

export function LisaPortfolioSummary({
  portfolioId: _portfolioId,
  snapshot,
}: {
  portfolioId: string;
  snapshot: LisaSnapshot | null;
}) {
  if (!snapshot) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        Pas encore de snapshot — génère une proposition pour commencer.
      </div>
    );
  }

  const totalValue = parseFloat(snapshot.total_value_usd ?? '0') || 0;
  const cash = parseFloat(snapshot.cash_usd ?? '0') || 0;
  const openValue = parseFloat(snapshot.open_positions_value_usd ?? '0') || 0;
  const realized = parseFloat(snapshot.realized_pnl_cumulative_usd ?? '0') || 0;
  const unrealized = parseFloat(snapshot.unrealized_pnl_usd ?? '0') || 0;
  const retPct = Number(snapshot.return_from_inception_pct ?? 0) || 0;
  const drawdown = Number(snapshot.drawdown_from_peak_pct ?? 0) || 0;
  const openCount = snapshot.open_positions_count ?? 0;

  const retSign = retPct >= 0 ? '+' : '';
  const retColor =
    retPct > 0 ? 'text-emerald-600' : retPct < 0 ? 'text-red-500' : '';

  const dd2dWarning = drawdown < -8;  // warning near hard kill at -10%

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiCard
        label="Valeur totale"
        value={`${totalValue.toFixed(2)} USD`}
        hint={`Cash ${cash.toFixed(0)} + Positions ${openValue.toFixed(0)}`}
      />
      <KpiCard
        label="Return inception"
        value={<span className={retColor}>{retSign}{retPct.toFixed(2)}%</span>}
        hint="Depuis création du portefeuille simu"
      />
      <KpiCard
        label="P&L"
        value={`${(realized + unrealized).toFixed(2)} USD`}
        hint={`Réalisé ${realized.toFixed(0)} · Latent ${unrealized.toFixed(0)}`}
      />
      <KpiCard
        label="Drawdown peak"
        value={<span className={drawdown <= -5 ? 'text-red-500' : 'text-muted-foreground'}>{drawdown.toFixed(2)}%</span>}
        hint={dd2dWarning ? '⚠️ Proche kill limit -10%' : `${openCount} position(s) ouverte(s)`}
      />
    </div>
  );
}
