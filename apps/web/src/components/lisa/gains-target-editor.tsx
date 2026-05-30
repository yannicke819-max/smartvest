'use client';

/**
 * GainsTargetEditor — modal/bottom sheet pour éditer les cibles Mode C.
 *
 * Mode C = MAX(usd plancher, pct × capital). User édite les 2 valeurs pour
 * chaque scope (daily/monthly/annual). Live preview de la cible effective.
 *
 * Desktop : modal centré · Mobile : bottom sheet (slide up).
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import {
  useUpdateLisaTargets,
  computeEffectiveTarget,
  type LisaTargets,
} from '@/hooks/use-lisa-targets';

interface Props {
  portfolioId: string;
  targets: LisaTargets;
  currentCapital: number;
  onClose: () => void;
}

export function GainsTargetEditor({ portfolioId, targets, currentCapital, onClose }: Props) {
  const [mounted, setMounted] = useState(false);
  const [dailyUsd, setDailyUsd] = useState(targets.daily.usd);
  const [dailyPct, setDailyPct] = useState(targets.daily.pct);
  const [monthlyUsd, setMonthlyUsd] = useState(targets.monthly.usd);
  const [monthlyPct, setMonthlyPct] = useState(targets.monthly.pct);
  const [annualUsd, setAnnualUsd] = useState(targets.annual.usd);
  const [annualPct, setAnnualPct] = useState(targets.annual.pct);
  const { updateTargets, isLoading } = useUpdateLisaTargets(portfolioId);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const effDaily = computeEffectiveTarget(dailyUsd, dailyPct, currentCapital);
  const effMonthly = computeEffectiveTarget(monthlyUsd, monthlyPct, currentCapital);
  const effAnnual = computeEffectiveTarget(annualUsd, annualPct, currentCapital);

  const handleSave = async () => {
    await updateTargets({
      daily: { usd: dailyUsd, pct: dailyPct, effective: 0 },
      monthly: { usd: monthlyUsd, pct: monthlyPct, effective: 0 },
      annual: { usd: annualUsd, pct: annualPct, effective: 0 },
    });
    onClose();
  };

  const InputRow = ({
    label,
    usd,
    pct,
    effective,
    setUsd,
    setPct,
  }: {
    label: string;
    usd: number;
    pct: number;
    effective: number;
    setUsd: (v: number) => void;
    setPct: (v: number) => void;
  }) => (
    <div className="space-y-2 border-b pb-3 last:border-b-0">
      <label className="text-xs font-semibold">{label}</label>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-muted-foreground">Plancher $</label>
          <input
            type="number"
            value={usd}
            onChange={(e) => setUsd(Number(e.target.value))}
            className="w-full rounded border px-2 py-1.5 text-sm bg-background"
            min={0}
            step={10}
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground">% capital</label>
          <input
            type="number"
            value={pct}
            onChange={(e) => setPct(Number(e.target.value))}
            className="w-full rounded border px-2 py-1.5 text-sm bg-background"
            min={0}
            step={0.1}
          />
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground">
        → Cible effective : <span className="font-medium text-foreground">${effective.toFixed(0)}</span>
        {' '}(MAX(${usd.toFixed(0)}, {pct}% × ${currentCapital.toFixed(0)}))
      </div>
    </div>
  );

  const content = (
    <>
      <button
        type="button"
        onClick={onClose}
        className="fixed inset-0 bg-black/50 z-40"
        aria-label="Fermer"
      />
      {/* Desktop : modal centré · Mobile : bottom sheet */}
      <div
        className="fixed z-50 bg-card border shadow-lg
                   md:rounded-lg md:p-6 md:max-w-md md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2
                   max-md:left-0 max-md:right-0 max-md:bottom-0 max-md:rounded-t-2xl max-md:p-4 max-md:pb-8"
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold">🎯 Modifier objectifs</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground text-xl"
            aria-label="Fermer"
          >
            ×
          </button>
        </div>

        <p className="text-[11px] text-muted-foreground mb-3">
          Mode C : Cible effective = MAX(plancher $, % × capital actuel ${currentCapital.toFixed(0)}).
        </p>

        <div className="space-y-3">
          <InputRow
            label="Jour"
            usd={dailyUsd}
            pct={dailyPct}
            effective={effDaily}
            setUsd={setDailyUsd}
            setPct={setDailyPct}
          />
          <InputRow
            label="Mois"
            usd={monthlyUsd}
            pct={monthlyPct}
            effective={effMonthly}
            setUsd={setMonthlyUsd}
            setPct={setMonthlyPct}
          />
          <InputRow
            label="Année"
            usd={annualUsd}
            pct={annualPct}
            effective={effAnnual}
            setUsd={setAnnualUsd}
            setPct={setAnnualPct}
          />
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            Annuler
          </Button>
          <Button onClick={handleSave} disabled={isLoading}>
            {isLoading ? 'Sauvegarde…' : 'Sauvegarder'}
          </Button>
        </div>
      </div>
    </>
  );

  return createPortal(content, document.body);
}
