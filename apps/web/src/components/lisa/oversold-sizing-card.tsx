'use client';

import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useOversoldSizing, useUpdateOversoldSizing, type OversoldSizing } from '@/hooks/use-oversold-sizing';

/**
 * OversoldSizingCard — réglage du sizing dynamique oversold (par portfolio).
 *
 * notional = base × multiplicateur(bande de drop) × amortisseur(VIX),
 * borné [plancher, plafond]. Automatique par défaut, tout configurable ici.
 */
export function OversoldSizingCard({ portfolioId }: { portfolioId: string }) {
  const { data, isLoading } = useOversoldSizing(portfolioId);
  const update = useUpdateOversoldSizing(portfolioId);
  const [form, setForm] = useState<OversoldSizing | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  if (isLoading || !form) {
    return <div className="rounded-lg border p-4 text-sm text-muted-foreground">⚙️ Chargement du sizing…</div>;
  }

  const f = form;
  const set = (k: keyof OversoldSizing, v: number | boolean) => setForm({ ...f, [k]: v });

  // Aperçu live (miroir client de la logique serveur).
  const ceiling = f.capitalUsd > 0 ? (f.capitalUsd * f.ceilingPctCapital) / 100 : Infinity;
  const clampPv = (n: number) => Math.round(Math.max(f.floorUsd, Math.min(ceiling, n)));
  const previews = f.enabled
    ? [
        { label: 'Drop −9% · VIX calme', usd: clampPv(f.baseNotionalUsd * f.bandMultDeep) },
        { label: 'Drop −6% · VIX calme', usd: clampPv(f.baseNotionalUsd * f.bandMultShallow) },
        { label: 'Drop −9% · VIX 20-30', usd: clampPv(f.baseNotionalUsd * f.bandMultDeep * f.vixDampElevated) },
        { label: 'Drop −9% · VIX ≥30', usd: clampPv(f.baseNotionalUsd * f.bandMultDeep * f.vixDampStress) },
      ]
    : [];

  const dirty = !!data && JSON.stringify(form) !== JSON.stringify(data);

  const save = () => {
    update.mutate(form, { onSuccess: () => setSavedAt(Date.now()) });
  };

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-indigo-600" />
          <h2 className="text-sm font-medium">⚙️ Sizing dynamique oversold</h2>
        </div>
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <span className={f.enabled ? 'text-emerald-600' : 'text-muted-foreground'}>
            {f.enabled ? 'Automatique activé' : 'Désactivé (taille fixe = base)'}
          </span>
        </label>
      </div>

      <p className="text-[11px] text-muted-foreground">
        À chaque ouverture : <strong>notional = base × multiplicateur(bande) × amortisseur(VIX)</strong>, borné plancher/plafond.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Field label="Base ($)" value={f.baseNotionalUsd} step={100} onChange={(v) => set('baseNotionalUsd', v)} />
        <Field label="Capital ($)" value={f.capitalUsd} step={1000} onChange={(v) => set('capitalUsd', v)} />
        <Field label="Mult. −8/−12% (deep)" value={f.bandMultDeep} step={0.1} onChange={(v) => set('bandMultDeep', v)} />
        <Field label="Mult. −5/−8% (shallow)" value={f.bandMultShallow} step={0.1} onChange={(v) => set('bandMultShallow', v)} />
        <Field label="VIX 20-30 (×)" value={f.vixDampElevated} step={0.05} onChange={(v) => set('vixDampElevated', v)} />
        <Field label="VIX ≥30 (×)" value={f.vixDampStress} step={0.05} onChange={(v) => set('vixDampStress', v)} />
        <Field label="🔻 Plancher ($)" value={f.floorUsd} step={50} onChange={(v) => set('floorUsd', v)} />
        <Field label="🔺 Plafond (% capital)" value={f.ceilingPctCapital} step={1} onChange={(v) => set('ceilingPctCapital', v)} />
      </div>

      {previews.length > 0 && (
        <div className="rounded-md bg-muted/40 p-3 space-y-1">
          <div className="text-[10px] uppercase text-muted-foreground">Aperçu (plafond = ${Math.round(ceiling).toLocaleString()})</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {previews.map((p) => (
              <div key={p.label} className="flex justify-between">
                <span className="text-muted-foreground">{p.label}</span>
                <span className="font-medium tabular-nums">${p.usd.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={!dirty || update.isPending}
          className="rounded-md bg-indigo-600 text-white text-xs px-3 py-1.5 disabled:opacity-40 hover:bg-indigo-700"
        >
          {update.isPending ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        {update.isError && <span className="text-xs text-rose-500">{String(update.error).slice(0, 80)}</span>}
        {savedAt && !dirty && !update.isError && <span className="text-xs text-emerald-600">✓ Enregistré</span>}
        {dirty && <span className="text-xs text-amber-600">Modifications non enregistrées</span>}
      </div>

      <p className="text-[11px] text-muted-foreground italic">
        S&apos;applique aux <strong>nouvelles</strong> entrées. Concentre le capital sur les chutes profondes (meilleur rebond
        historique : −8/−12% → +2,45% vs −5/−8% → +1%) et réduit en marché stressé (VIX).
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="rounded border bg-background px-2 py-1 text-sm tabular-nums"
      />
    </label>
  );
}
