'use client';

import Link from 'next/link';
import { ArrowLeft, Gauge, Clock, ShieldAlert, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import {
  useStrategyModes,
  useCurrentStrategyMode,
  type OperatingTempo,
  type RiskIntensityLevel,
} from '@/hooks/use-hyper-trading';

const TEMPO_LABEL: Record<OperatingTempo, string> = {
  LONG_HORIZON: 'Long terme',
  ACTIVE: 'Actif',
  HYPER_ACTIVE: 'Hyper-actif',
};

const TEMPO_DESCRIPTION: Record<OperatingTempo, string> = {
  LONG_HORIZON:
    'Cadence buy-and-hold — analyse quotidienne, suggestions rares. Adapté à un horizon long terme.',
  ACTIVE:
    'Cadence active — analyse horaire, suggestions plus fréquentes. Pour un swing trading personnel.',
  HYPER_ACTIVE:
    'Mode opératoire personnel très intensif — analyse toutes les 5 minutes, garde-fous renforcés, kill-switch obligatoire. Strictement opt-in.',
};

const RISK_LABEL: Record<RiskIntensityLevel, string> = {
  low: 'Risque faible',
  moderate: 'Risque modéré',
  high: 'Risque élevé',
  very_high: 'Risque très élevé',
};

const RISK_STYLE: Record<RiskIntensityLevel, string> = {
  low: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  moderate: 'bg-sky-50 text-sky-700 border-sky-200',
  high: 'bg-amber-50 text-amber-700 border-amber-200',
  very_high: 'bg-red-50 text-red-700 border-red-200',
};

function formatCadence(min: number): string {
  if (min < 60) return `toutes les ${min} min`;
  if (min < 60 * 24) return `toutes les ${Math.round(min / 60)} h`;
  return `chaque jour`;
}

export default function StrategyModePage() {
  const modesQuery = useStrategyModes();
  const currentQuery = useCurrentStrategyMode();
  const current = currentQuery.data;
  const modes = modesQuery.data ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Retour
          </Button>
        </Link>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Gauge className="h-5 w-5 text-muted-foreground" />
            Mode opératoire
          </h1>
          <p className="text-sm text-muted-foreground">
            Choisissez la cadence de SmartVest. Le mode opératoire complète — sans le remplacer —
            le cadre de délégation déjà configuré.
          </p>
        </div>
      </div>

      <DisclaimerBanner />

      {/* Current mode summary */}
      {currentQuery.isLoading ? (
        <SkeletonCard />
      ) : (
        <div className="rounded-lg border p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Mode actif</p>
          <p className="mt-1 text-lg font-semibold">
            {TEMPO_LABEL[current?.tempo ?? 'LONG_HORIZON']}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {TEMPO_DESCRIPTION[current?.tempo ?? 'LONG_HORIZON']}
          </p>
        </div>
      )}

      {/* Mode catalogue */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Modes disponibles</h2>
        {modesQuery.isLoading ? (
          <div className="grid gap-3 md:grid-cols-3">
            {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {modes.map((m) => {
              const isCurrent = current?.tempo === m.tempo;
              return (
                <div
                  key={m.tempo}
                  className={`rounded-lg border p-4 ${isCurrent ? 'border-primary bg-primary/5' : ''}`}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">{TEMPO_LABEL[m.tempo]}</h3>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${RISK_STYLE[m.riskLevel]}`}>
                      {RISK_LABEL[m.riskLevel]}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{TEMPO_DESCRIPTION[m.tempo]}</p>
                  <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    Analyse {formatCadence(m.reviewIntervalMinutes)}
                  </div>
                  {m.tempo === 'HYPER_ACTIVE' && (
                    <Link
                      href="/settings/hyper-trading"
                      className="mt-3 flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      Configurer <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Personal override — sniper */}
      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium">Surcouche personnelle</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Mode sniper — cadence renforcée temporaire, déverrouillable par code, TTL borné. Ne
          contourne ni mandat ni kill-switch.
        </p>
        <Link
          href="/settings/sniper"
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Configurer le mode sniper →
        </Link>
      </section>

      {/* Doctrine reminder */}
      <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1.5">
            <p className="font-semibold">Le mode opératoire ne contourne JAMAIS la délégation.</p>
            <p>
              Le mode hyper-actif ne crée aucune exécution implicite. Toute action reste soumise
              au mode de délégation choisi (manuel, hybride, autonome) et aux garde-fous d'un
              mandat valide. Activer hyper-actif <em>renforce</em> les contrôles ; il ne les
              relâche jamais.
            </p>
            <p>
              Les performances passées ne préjugent pas des performances futures. Aucune garantie
              de rendement.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
