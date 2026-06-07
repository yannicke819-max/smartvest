'use client';

import { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import {
  useOversoldEmpiricalLaw,
  type OversoldLawTable,
  type OversoldLawBucket,
} from '@/hooks/use-oversold-empirical-law';

/**
 * PR-2 (widget loi empirique) — loi empirique oversold par bande de drop 1j.
 *
 * Deux lentilles, sélectionnables :
 *  - « Réalisé » : winRate / PnL moyen des trades CLÔTURÉS (dispo tout de suite).
 *    ⚠ mêle qualité d'entrée ET timing de sortie.
 *  - « J+10 » : winRate / rendement à horizon fixe J+10 = qualité d'ENTRÉE isolée.
 *    Se peuple à mesure que chaque entrée atteint J+10 ouvré (~18/06).
 *
 * Intervalle de Wilson 95% sur le winRate par bande → signale les bandes à petit n.
 */
export function OversoldEmpiricalLawPanel({ portfolioId }: { portfolioId: string }) {
  const { data, isLoading, isError } = useOversoldEmpiricalLaw(portfolioId);
  const [lens, setLens] = useState<'realized' | 'j10'>('realized');

  if (isLoading) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        📊 Chargement de la loi empirique…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        📊 Loi empirique indisponible pour le moment.
      </div>
    );
  }

  const table: OversoldLawTable = lens === 'realized' ? data.realized : data.forwardJ10;
  const valueLabel = lens === 'realized' ? 'PnL moyen' : 'Ret. J+10 moyen';

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-purple-600" />
          <h2 className="text-sm font-medium">📊 Loi empirique — par bande de drop</h2>
        </div>
        <div className="flex gap-1 rounded-md border p-0.5">
          <LensButton active={lens === 'realized'} onClick={() => setLens('realized')}>
            Réalisé ({data.realized.sampleSize})
          </LensButton>
          <LensButton active={lens === 'j10'} onClick={() => setLens('j10')}>
            J+10 ({data.forwardJ10.sampleSize})
          </LensButton>
        </div>
      </div>

      {/* Bandeau résumé global */}
      {table.sampleSize > 0 ? (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Summary label="Échantillon" value={`${table.sampleSize} trades`} />
          <Summary
            label="Win rate global"
            value={table.overallWinRatePct != null ? `${table.overallWinRatePct.toFixed(0)}%` : '—'}
          />
          <Summary
            label={valueLabel}
            value={table.overallAvgPct != null ? `${table.overallAvgPct >= 0 ? '+' : ''}${table.overallAvgPct.toFixed(2)}%` : '—'}
            valueCls={table.overallAvgPct != null ? (table.overallAvgPct >= 0 ? 'text-emerald-600' : 'text-red-600') : ''}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">
          {lens === 'j10'
            ? `Aucun label J+${data.forwardJ10.horizonDays} disponible pour l’instant — la loi de qualité d’entrée se peuplera à mesure que les entrées atteignent J+${data.forwardJ10.horizonDays} ouvré (≈ mi-juin). Bascule sur « Réalisé » en attendant.`
            : 'Aucun trade clôturé pour l’instant sur ce portefeuille.'}
        </p>
      )}

      {/* Table par bande */}
      {table.byDropBand.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="py-1.5 pr-2">Bande de drop 1j</th>
                <th className="py-1.5 px-2 text-right">n</th>
                <th className="py-1.5 px-2 text-right">Win rate</th>
                <th className="py-1.5 px-2 text-right">IC 95% (Wilson)</th>
                <th className="py-1.5 pl-2 text-right">{valueLabel}</th>
              </tr>
            </thead>
            <tbody>
              {table.byDropBand.map((b) => (
                <LawRow key={b.label} b={b} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground italic">
        {lens === 'realized'
          ? 'Réalisé = PnL des trades clôturés : mêle la qualité d’entrée ET le timing de sortie. Pour isoler la qualité d’entrée, voir l’onglet J+10.'
          : `J+${data.forwardJ10.horizonDays} = rendement à horizon fixe depuis l’entrée : isole la qualité d’ENTRÉE (indépendant du timing de sortie).`}{' '}
        L’IC de Wilson large = échantillon encore petit, prudence. MAJ {new Date(data.asOf).toLocaleTimeString('fr-FR')}.
      </p>
    </div>
  );
}

function LensButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
      }`}
    >
      {children}
    </button>
  );
}

function Summary(props: { label: string; value: string; valueCls?: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[10px] uppercase text-muted-foreground">{props.label}</div>
      <div className={`text-sm font-semibold tabular-nums ${props.valueCls ?? ''}`}>{props.value}</div>
    </div>
  );
}

function LawRow({ b }: { b: OversoldLawBucket }) {
  const wr = b.winRatePct;
  const wrCls = wr == null ? 'text-muted-foreground' : wr >= 50 ? 'text-emerald-600' : 'text-red-600';
  const avgCls =
    b.avgPct == null ? 'text-muted-foreground' : b.avgPct >= 0 ? 'text-emerald-600' : 'text-red-600';
  return (
    <tr className="border-b last:border-0">
      <td className="py-1.5 pr-2 font-medium">{b.label}</td>
      <td className="py-1.5 px-2 text-right tabular-nums">{b.n}</td>
      <td className={`py-1.5 px-2 text-right tabular-nums ${wrCls}`}>
        {wr != null ? `${wr.toFixed(0)}%` : '—'}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">
        {b.ciLowPct != null && b.ciHighPct != null
          ? `${b.ciLowPct.toFixed(0)}–${b.ciHighPct.toFixed(0)}%`
          : '—'}
      </td>
      <td className={`py-1.5 pl-2 text-right tabular-nums ${avgCls}`}>
        {b.avgPct != null ? `${b.avgPct >= 0 ? '+' : ''}${b.avgPct.toFixed(2)}%` : '—'}
      </td>
    </tr>
  );
}
