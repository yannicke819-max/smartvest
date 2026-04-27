'use client';

import { useState } from 'react';
import { TrendingUp, Wheat, Settings, AlertCircle } from 'lucide-react';
import { useMacroMode, useApplyMacroMode } from '@/hooks/use-macro-mode';

/**
 * MacroModeSelector — toggle radio en haut de /lisa pour sélectionner
 * la philosophie opérationnelle :
 *
 *   📈 INVESTMENT — buy-and-hold patient, long horizon
 *   🌾 HARVEST   — discipline journalière, sweep automatique
 *
 * Détecte automatiquement le mode courant depuis la config session.
 * Au clic, applique un preset complet (profile + capital_discipline_mode +
 * risk_constraints + autopilot_aggressive). Les paramètres détaillés
 * restent modifiables dans les sections "Avancé".
 */
export function MacroModeSelector({ portfolioId }: { portfolioId: string }) {
  const modeQuery = useMacroMode(portfolioId);
  const applyMut = useApplyMacroMode(portfolioId);
  const [confirmMode, setConfirmMode] = useState<'INVESTMENT' | 'HARVEST' | null>(null);

  const currentMode = modeQuery.data?.mode ?? 'CUSTOM';

  const handleSelect = (newMode: 'INVESTMENT' | 'HARVEST') => {
    if (currentMode === newMode) return;
    // Demander confirmation pour éviter le reset accidentel des params custom
    setConfirmMode(newMode);
  };

  const handleConfirm = async () => {
    if (!confirmMode) return;
    try {
      await applyMut.mutateAsync(confirmMode);
      setConfirmMode(null);
    } catch (e) {
      alert(`Erreur: ${String(e).slice(0, 200)}`);
    }
  };

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Settings className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Mode opératoire</h2>
          {currentMode === 'CUSTOM' && (
            <span className="text-[10px] uppercase rounded px-1.5 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-950/40">
              Config custom
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* INVESTMENT */}
        <ModeCard
          mode="INVESTMENT"
          icon={TrendingUp}
          title="📈 Investment"
          subtitle="Buy-and-hold patient · long horizon"
          description="Stops larges (4%), target deployment 90%, capital qui croît avec les positions, pas de sweep automatique. Profil long-terme."
          isActive={currentMode === 'INVESTMENT'}
          onClick={() => handleSelect('INVESTMENT')}
          color="blue"
        />
        {/* HARVEST */}
        <ModeCard
          mode="HARVEST"
          icon={Wheat}
          title="🌾 Harvest"
          subtitle="Discipline journalière · sweep automatique"
          description="Stops serrés (1.5%), take-profit absolu modifiable (défaut 2.5%), capital de travail FIXE, profits sweepés vers vault PER_TRADE. Reset chaque jour 09:00."
          isActive={currentMode === 'HARVEST'}
          onClick={() => handleSelect('HARVEST')}
          color="emerald"
        />
      </div>

      <p className="text-[11px] text-muted-foreground italic">
        Les paramètres détaillés (presets risque, levier, stops, target jour) restent
        modifiables dans les sections « Configuration de session » et « Daily Harvest »
        ci-dessous, même après application d&apos;un preset.
      </p>

      {/* Modal de confirmation */}
      {confirmMode && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-amber-700 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs space-y-1">
              <p className="font-medium">
                Confirmer le passage en mode {confirmMode === 'INVESTMENT' ? '📈 Investment' : '🌾 Harvest'} ?
              </p>
              <p className="text-muted-foreground">
                Cette action écrase les paramètres suivants : profile, capital_discipline_mode,
                risk_constraints (caps, stops, leverage), autopilot_aggressive, cycle_minutes.
                Les autres champs (capital, objectifs, kill-switch) sont préservés.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={applyMut.isPending}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {applyMut.isPending ? 'Application…' : 'Confirmer'}
            </button>
            <button
              onClick={() => setConfirmMode(null)}
              className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
            >
              Annuler
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ModeCard(props: {
  mode: 'INVESTMENT' | 'HARVEST';
  icon: typeof TrendingUp;
  title: string;
  subtitle: string;
  description: string;
  isActive: boolean;
  onClick: () => void;
  color: 'blue' | 'emerald';
}) {
  const Icon = props.icon;

  const activeStyles = props.color === 'blue'
    ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 ring-2 ring-blue-500/20'
    : 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 ring-2 ring-emerald-500/20';

  return (
    <button
      onClick={props.onClick}
      className={`text-left rounded-lg border p-3 space-y-2 transition-all ${
        props.isActive
          ? activeStyles
          : 'hover:bg-muted/50 hover:border-foreground/20'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${props.color === 'blue' ? 'text-blue-600' : 'text-emerald-600'}`} />
          <h3 className="text-sm font-medium">{props.title}</h3>
        </div>
        {props.isActive && (
          <span className={`text-[10px] uppercase rounded px-1.5 py-0.5 font-medium ${
            props.color === 'blue'
              ? 'bg-blue-600 text-white'
              : 'bg-emerald-600 text-white'
          }`}>
            Actif
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground italic">{props.subtitle}</p>
      <p className="text-xs text-muted-foreground">{props.description}</p>
    </button>
  );
}
