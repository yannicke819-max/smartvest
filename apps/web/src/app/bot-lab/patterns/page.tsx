'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles, RefreshCw, ArrowLeft, ShieldCheck, AlertTriangle, Clock, Eye, Lightbulb, Lock, X } from 'lucide-react';
import {
  usePatterns,
  useMinePatterns,
  useAdoptions,
  useAdoptPattern,
  useDeactivateAdoption,
  type BotPattern,
  type PatternStatus,
  type AdoptionLevel,
  type PatternAdoption,
} from '@/hooks/use-bot-lab';
import { usePortfolios } from '@/hooks/use-portfolio';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export default function PatternsPage() {
  const [statusFilter, setStatusFilter] = useState<PatternStatus | 'all'>('all');
  const patternsQuery = usePatterns(statusFilter === 'all' ? undefined : statusFilter);
  const mineMut = useMinePatterns();
  const portfoliosQuery = usePortfolios();
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string | null>(null);

  // Auto-select 1er portfolio simulation
  useEffect(() => {
    if (selectedPortfolioId) return;
    const sim = portfoliosQuery.data?.find((p) => p.is_simulation);
    if (sim) setSelectedPortfolioId(sim.id);
  }, [portfoliosQuery.data, selectedPortfolioId]);

  const adoptionsQuery = useAdoptions(selectedPortfolioId);
  const adoptionsMap = new Map(
    (adoptionsQuery.data?.adoptions ?? []).map((a) => [a.pattern_id, a]),
  );

  const handleMine = async () => {
    try {
      const r = await mineMut.mutateAsync();
      alert(`Mining terminé : ${r.minedCount} patterns extraits (${r.createdCount} nouveaux + ${r.updatedCount} mis à jour)`);
    } catch (e) {
      alert(`Erreur mining: ${String(e).slice(0, 200)}`);
    }
  };

  const patterns = patternsQuery.data?.patterns ?? [];
  const validatedCount = patterns.filter((p) => p.status === 'validated').length;
  const candidateCount = patterns.filter((p) => p.status === 'candidate').length;

  return (
    <div className="container mx-auto p-4 space-y-6 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link
            href="/bot-lab"
            className="text-xs text-muted-foreground hover:underline flex items-center gap-1 mb-2"
          >
            <ArrowLeft className="h-3 w-3" />
            Retour Bot Lab
          </Link>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-amber-600" />
            Pattern Miner
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Extrait les patterns récurrents de tous tes bots, mesure leur
            robustesse cross-régimes et leur score composite.
          </p>
        </div>
        <button
          onClick={handleMine}
          disabled={mineMut.isPending}
          className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
        >
          <RefreshCw className={`h-3 w-3 ${mineMut.isPending ? 'animate-spin' : ''}`} />
          {mineMut.isPending ? 'Mining…' : 'Lancer le mining'}
        </button>
      </div>

      {/* Stats top */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          label="Total patterns"
          value={String(patterns.length)}
          color="text-foreground"
        />
        <StatCard
          label="Validés (score > 50)"
          value={String(validatedCount)}
          color="text-emerald-700 dark:text-emerald-300"
        />
        <StatCard
          label="Candidats"
          value={String(candidateCount)}
          color="text-amber-700 dark:text-amber-400"
        />
      </div>

      {/* Filtre status */}
      <div className="flex gap-2 text-xs">
        {(['all', 'validated', 'candidate', 'rejected', 'deprecated'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s as PatternStatus | 'all')}
            className={`rounded-md px-3 py-1.5 font-medium border transition-colors ${
              statusFilter === s
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border hover:bg-muted'
            }`}
          >
            {s === 'all' ? 'Tous' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Liste */}
      {patternsQuery.isLoading && (
        <div className="text-sm text-muted-foreground">Chargement…</div>
      )}

      {!patternsQuery.isLoading && patterns.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground space-y-2">
          <p>Aucun pattern encore.</p>
          <p className="text-xs">
            Importe des trades dans tes bots, recalcule les métriques (regime tagging),
            puis clique &quot;Lancer le mining&quot; ci-dessus.
          </p>
        </div>
      )}

      {/* Sélecteur portfolio pour adoptions */}
      {portfoliosQuery.data && portfoliosQuery.data.length > 0 && (
        <div className="rounded-lg border p-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs text-muted-foreground">Portfolio cible pour adoptions :</span>
          <select
            value={selectedPortfolioId ?? ''}
            onChange={(e) => setSelectedPortfolioId(e.target.value || null)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            {portfoliosQuery.data.filter((p) => p.is_simulation).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {adoptionsQuery.data && (
            <span className="text-[10px] text-muted-foreground">
              {adoptionsQuery.data.adoptions.length} adoption(s) active(s)
            </span>
          )}
        </div>
      )}

      {patterns.length > 0 && (
        <div className="space-y-3">
          {patterns.map((p) => (
            <PatternCard
              key={p.id}
              pattern={p}
              portfolioId={selectedPortfolioId}
              currentAdoption={adoptionsMap.get(p.id) ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard(props: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{props.label}</div>
      <div className={`text-2xl font-mono font-bold tabular-nums mt-1 ${props.color}`}>{props.value}</div>
    </div>
  );
}

function PatternCard({
  pattern,
  portfolioId,
  currentAdoption,
}: {
  pattern: BotPattern;
  portfolioId: string | null;
  currentAdoption: PatternAdoption | null;
}) {
  const compositeScore = pattern.composite_score ?? 0;
  const robustness = pattern.robustness_score ?? 0;
  const winRate = pattern.win_rate_pct ?? 0;
  const expectancy = parseFloat(pattern.expectancy_usd ?? '0');
  const adoptMut = useAdoptPattern();
  const deactivateMut = useDeactivateAdoption();
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  const handleAdopt = async (level: AdoptionLevel) => {
    if (!portfolioId) {
      alert('Sélectionne un portfolio cible d\'abord');
      return;
    }
    try {
      await adoptMut.mutateAsync({ patternId: pattern.id, portfolioId, level });
    } catch (e) {
      alert(`Erreur: ${String(e).slice(0, 200)}`);
    }
  };

  const handleDeactivate = async () => {
    if (!currentAdoption) return;
    setConfirmDeactivate(true);
  };

  const doDeactivate = async () => {
    if (!currentAdoption) return;
    setConfirmDeactivate(false);
    try {
      await deactivateMut.mutateAsync({ adoptionId: currentAdoption.id, reason: 'user_deactivated' });
    } catch (e) {
      alert(`Erreur: ${String(e).slice(0, 200)}`);
    }
  };

  const scoreColor = compositeScore >= 70
    ? 'text-emerald-600'
    : compositeScore >= 50
      ? 'text-amber-600'
      : 'text-red-600';

  const statusIcon = {
    validated: <ShieldCheck className="h-4 w-4 text-emerald-600" />,
    candidate: <Clock className="h-4 w-4 text-amber-600" />,
    rejected: <AlertTriangle className="h-4 w-4 text-red-600" />,
    deprecated: <AlertTriangle className="h-4 w-4 text-slate-500" />,
  }[pattern.status];

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {statusIcon}
            <h3 className="font-medium text-sm">{pattern.name}</h3>
            <span className="text-[10px] uppercase rounded px-1.5 py-0.5 bg-muted text-muted-foreground">
              {pattern.status}
            </span>
            <span className="text-[10px] uppercase rounded px-1.5 py-0.5 bg-muted text-muted-foreground">
              {pattern.pattern_kind}
            </span>
          </div>
          {pattern.description && (
            <p className="text-xs text-muted-foreground">{pattern.description}</p>
          )}
        </div>
        <div className="text-right">
          <div className={`text-2xl font-mono font-bold ${scoreColor}`}>
            {compositeScore.toFixed(0)}
          </div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Composite
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t text-xs">
        <Metric label="Observations" value={String(pattern.observation_count)} />
        <Metric
          label="Win Rate"
          value={`${winRate.toFixed(1)}%`}
          color={winRate >= 55 ? 'text-emerald-600' : winRate >= 45 ? 'text-amber-600' : 'text-red-600'}
        />
        <Metric
          label="Expectancy"
          value={`${expectancy >= 0 ? '+' : ''}$${expectancy.toFixed(2)}`}
          color={expectancy >= 0 ? 'text-emerald-600' : 'text-red-600'}
        />
        <Metric
          label="Robustness"
          value={`${robustness.toFixed(0)}%`}
          color={robustness >= 75 ? 'text-emerald-600' : robustness >= 50 ? 'text-amber-600' : 'text-red-600'}
        />
      </div>

      {/* Conditions */}
      <div className="flex flex-wrap gap-1.5 pt-2 border-t">
        {Object.entries(pattern.conditions).map(([k, v]) => (
          <span key={k} className="text-[10px] rounded bg-muted px-2 py-0.5 font-mono">
            {k}={String(v)}
          </span>
        ))}
      </div>

      {/* Adoption controls */}
      <div className="flex items-center justify-between pt-2 border-t flex-wrap gap-2">
        <div className="text-[10px] text-muted-foreground">
          {currentAdoption ? (
            <span className="flex items-center gap-2">
              <span className="font-medium uppercase">{currentAdoption.adoption_level}</span>
              {currentAdoption.triggered_count > 0 && (
                <span>
                  · {currentAdoption.triggered_count} matches Lisa,{' '}
                  {currentAdoption.triggered_winning_count}/{currentAdoption.triggered_count} won
                </span>
              )}
            </span>
          ) : (
            <span>Pas adopté pour ce portfolio</span>
          )}
        </div>
        <div className="flex gap-1.5">
          {currentAdoption ? (
            <button
              onClick={handleDeactivate}
              disabled={deactivateMut.isPending}
              className="rounded-md border border-red-200 dark:border-red-900 px-2 py-1 text-[10px] font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center gap-1"
            >
              <X className="h-3 w-3" />
              Désactiver
            </button>
          ) : (
            <>
              <button
                onClick={() => handleAdopt('observe')}
                disabled={adoptMut.isPending || !portfolioId}
                className="rounded-md border px-2 py-1 text-[10px] font-medium hover:bg-muted disabled:opacity-50 flex items-center gap-1"
                title="Observer uniquement — pas d'action automatique"
              >
                <Eye className="h-3 w-3" />
                Observer
              </button>
              <button
                onClick={() => handleAdopt('suggest')}
                disabled={adoptMut.isPending || !portfolioId}
                className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/40 px-2 py-1 text-[10px] font-medium hover:bg-amber-100 disabled:opacity-50 flex items-center gap-1"
                title="Lisa intègre dans le briefing comme recommandation"
              >
                <Lightbulb className="h-3 w-3" />
                Suggest
              </button>
              <button
                onClick={() => handleAdopt('enforce')}
                disabled={adoptMut.isPending || !portfolioId}
                className="rounded-md border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-1 text-[10px] font-medium hover:bg-emerald-100 disabled:opacity-50 flex items-center gap-1"
                title="Lisa doit respecter (briefing strict, refus si contradiction)"
              >
                <Lock className="h-3 w-3" />
                Enforce
              </button>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeactivate}
        title="Désactiver cette adoption ?"
        description={`Désactiver l'adoption ${currentAdoption?.adoption_level ?? ''} de ce pattern ?`}
        confirmLabel="Désactiver"
        dangerous
        onConfirm={doDeactivate}
        onCancel={() => setConfirmDeactivate(false)}
      />
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-mono font-medium tabular-nums ${color ?? 'text-foreground'}`}>{value}</div>
    </div>
  );
}
