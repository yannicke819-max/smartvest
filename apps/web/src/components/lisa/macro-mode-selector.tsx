'use client';

import { useState } from 'react';
import { TrendingUp, Wheat, TrendingDown, Settings, AlertCircle } from 'lucide-react';
import {
  useOperatingMode,
  useApplyOperatingMode,
  type OperatingMode,
} from '@/hooks/use-operating-mode';

/**
 * P7-MODE-GAINERS-BADGE — Sélecteur 3-modes opératoires.
 *
 *   📈 INVESTMENT — buy-and-hold patient, long horizon (Lisa LLM)
 *   🌾 HARVEST    — discipline journalière, sweep auto (Lisa LLM)
 *   🚀 GAINERS    — scanner momentum 24/7 déterministe (bypass LLM)
 *
 * Source de vérité : `lisa_session_configs.strategy_mode` (toggle DB-level,
 * pas besoin de redeploy Fly). Le clic confirme, applique le preset
 * et invalide les query keys liées (macro-mode, daily-harvest, gainers-status).
 *
 * Le composant garde son nom historique `MacroModeSelector` pour minimiser
 * la churn d'imports — la page /lisa l'instancie inchangée.
 */
export function MacroModeSelector({ portfolioId }: { portfolioId: string }) {
  const modeQuery = useOperatingMode(portfolioId);
  const applyMut = useApplyOperatingMode(portfolioId);
  const [confirmMode, setConfirmMode] = useState<OperatingMode | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const currentMode: OperatingMode = modeQuery.data?.mode ?? 'investment';

  const handleSelect = (newMode: OperatingMode) => {
    if (currentMode === newMode) return;
    setApplyError(null);
    setConfirmMode(newMode);
  };

  const handleConfirm = async () => {
    if (!confirmMode) return;
    try {
      await applyMut.mutateAsync(confirmMode);
      setConfirmMode(null);
    } catch (e) {
      setApplyError(String((e as Error)?.message ?? e).slice(0, 240));
    }
  };

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Settings className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Mode opératoire</h2>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ModeCard
          icon={TrendingUp}
          title="📈 Investment"
          subtitle="Buy-and-hold patient · long horizon"
          description="Stops larges (4%), target deployment 90%, capital qui croît avec les positions, pas de sweep automatique. Profil long-terme."
          isActive={currentMode === 'investment'}
          onClick={() => handleSelect('investment')}
          color="blue"
        />
        <ModeCard
          icon={Wheat}
          title="🌾 Harvest"
          subtitle="Discipline journalière · sweep automatique"
          description="Stops serrés (1.5%), take-profit absolu modifiable (défaut 2.5%), capital de travail FIXE, profits sweepés vers vault PER_TRADE. Reset chaque jour 09:00."
          isActive={currentMode === 'harvest'}
          onClick={() => handleSelect('harvest')}
          color="emerald"
        />
        <ModeCard
          icon={TrendingDown}
          title="📉 Oversold"
          subtitle="Mean-reversion swing · achète les chutes · scan EOD + intraday"
          description="Inverse du momentum : achète les titres ayant chuté de -5 à -12% sur 1J (sur-réaction), exclut les falling-knife (<-12%). Hold J+10 ouvrés, stop catastrophe -15% par position, book diversifié (~150 lignes). Edge mean-reversion validé 3-fold (alpha +1.4% vs SPY, N=1416)."
          isActive={currentMode === 'oversold'}
          onClick={() => handleSelect('oversold')}
          color="purple"
        />
      </div>

      <p className="text-[11px] text-muted-foreground italic">
        Les paramètres détaillés (presets risque, levier, stops, target jour) restent
        modifiables dans les sections « Configuration de session » et « Daily Harvest »
        ci-dessous, même après application d&apos;un preset.
      </p>

      {confirmMode && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-amber-700 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs space-y-1">
              <p className="font-medium">
                Confirmer le passage en mode {LABEL_FOR[confirmMode]} ?
              </p>
              <p className="text-muted-foreground">
                {confirmMode === 'gainers'
                  ? 'Active le scanner Gainers (24/7 cross-asset). Autopilot activé, kill-switch désarmé. Profile et capital_discipline_mode actuels préservés.'
                  : confirmMode === 'oversold'
                  ? 'Active le scanner Oversold (mean-reversion swing, scan EOD post-close + intraday horaire EU + US). Achète les titres ayant chuté de -5 à -12%, hold J+10, stop catastrophe -15%/position. Autopilot activé, kill-switch désarmé. Exige capital ≥ $5000. Profile et capital_discipline_mode préservés.'
                  : 'Cette action écrase les paramètres suivants : profile, capital_discipline_mode, risk_constraints (caps, stops, leverage), autopilot_aggressive, cycle_minutes. Capital, objectifs, kill-switch préservés.'}
              </p>
              {applyError && (
                <p className="text-red-700 dark:text-red-400 font-medium">
                  Erreur : {applyError}
                </p>
              )}
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
              onClick={() => {
                setConfirmMode(null);
                setApplyError(null);
              }}
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

const LABEL_FOR: Record<OperatingMode, string> = {
  investment: '📈 Investment',
  harvest: '🌾 Harvest',
  gainers: '🚀 Gainers',
  oversold: '📉 Oversold',
};

type CardColor = 'blue' | 'emerald' | 'orange' | 'purple';

const ACTIVE_STYLES: Record<CardColor, string> = {
  blue: 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 ring-2 ring-blue-500/20',
  emerald: 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 ring-2 ring-emerald-500/20',
  orange: 'border-orange-500 bg-orange-50 dark:bg-orange-950/30 ring-2 ring-orange-500/20',
  purple: 'border-purple-500 bg-purple-50 dark:bg-purple-950/30 ring-2 ring-purple-500/20',
};

const ICON_COLORS: Record<CardColor, string> = {
  blue: 'text-blue-600',
  emerald: 'text-emerald-600',
  orange: 'text-orange-600',
  purple: 'text-purple-600',
};

const BADGE_COLORS: Record<CardColor, string> = {
  blue: 'bg-blue-600 text-white',
  emerald: 'bg-emerald-600 text-white',
  orange: 'bg-orange-600 text-white',
  purple: 'bg-purple-600 text-white',
};

function ModeCard(props: {
  icon: typeof TrendingUp;
  title: string;
  subtitle: string;
  description: string;
  isActive: boolean;
  onClick: () => void;
  color: CardColor;
}) {
  const Icon = props.icon;

  return (
    <button
      onClick={props.onClick}
      className={`text-left rounded-lg border p-3 space-y-2 transition-all ${
        props.isActive
          ? ACTIVE_STYLES[props.color]
          : 'hover:bg-muted/50 hover:border-foreground/20'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${ICON_COLORS[props.color]}`} />
          <h3 className="text-sm font-medium">{props.title}</h3>
        </div>
        {props.isActive && (
          <span className={`text-[10px] uppercase rounded px-1.5 py-0.5 font-medium ${BADGE_COLORS[props.color]}`}>
            Actif
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground italic">{props.subtitle}</p>
      <p className="text-xs text-muted-foreground">{props.description}</p>
    </button>
  );
}
