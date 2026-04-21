'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Cpu, BookOpen, FileText } from 'lucide-react';
import { useSignal, useAssessImpact, useFindAnalogs, useGenerateConclusion, type SignalConclusion } from '@/hooks/use-signals';
import { usePortfolios } from '@/hooks/use-portfolio';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';

const OUTPUT_MODE_LABELS: Record<string, string> = {
  information: 'Information',
  alert: 'Alerte recommandée',
  simulation: 'Simulation suggérée',
  suggestion: 'Suggestion',
  action_candidate: 'Candidat d\'action',
};

function ConclusionPanel({ conclusion }: { conclusion: SignalConclusion }) {
  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Conclusion structurée</h3>
        <div className="flex gap-2 text-xs">
          <span className="rounded bg-muted px-2 py-0.5">{OUTPUT_MODE_LABELS[conclusion.outputMode] ?? conclusion.outputMode}</span>
          <span className="rounded bg-muted px-2 py-0.5">Confiance : {conclusion.overallConfidence}</span>
          {conclusion.needsReview && <span className="rounded bg-yellow-100 text-yellow-700 px-2 py-0.5">Revue recommandée</span>}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{conclusion.summaryText}</p>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-xs font-medium mb-1">Scénario probable</p>
          <p className="text-sm text-muted-foreground">{conclusion.probableScenario}</p>
        </div>
        <div>
          <p className="text-xs font-medium mb-1">Risque principal</p>
          <p className="text-sm text-muted-foreground">{conclusion.mainRisk}</p>
        </div>
      </div>

      {conclusion.exposedSectors.length > 0 && (
        <div>
          <p className="text-xs font-medium mb-1">Secteurs exposés</p>
          <div className="flex flex-wrap gap-1">
            {conclusion.exposedSectors.map((s) => <span key={s} className="rounded bg-orange-50 text-orange-700 px-2 py-0.5 text-xs">{s}</span>)}
          </div>
        </div>
      )}

      <div>
        <p className="text-xs font-medium mb-1">Contre-arguments</p>
        <ul className="space-y-0.5">
          {conclusion.counterArguments.map((a, i) => (
            <li key={i} className="text-xs text-muted-foreground">· {a}</li>
          ))}
        </ul>
      </div>

      <div>
        <p className="text-xs font-medium mb-1">Actions proposées</p>
        <ul className="space-y-0.5">
          {conclusion.proposedActions.map((a, i) => (
            <li key={i} className="text-xs text-muted-foreground">· {a}</li>
          ))}
        </ul>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Mode de délégation : {conclusion.delegationMode} · Toute action requiert validation explicite · Les performances passées ne préjugent pas des performances futures.
      </p>
    </div>
  );
}

export default function SignalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const signalQuery = useSignal(id);
  const portfoliosQuery = usePortfolios();
  const portfolioId = portfoliosQuery.data?.[0]?.id ?? '';

  const assessMutation = useAssessImpact(id);
  const analogsMutation = useFindAnalogs(id);
  const conclusionMutation = useGenerateConclusion(id);

  const [conclusion, setConclusion] = useState<SignalConclusion | null>(null);

  const signal = signalQuery.data;

  if (signalQuery.isLoading) return <div className="mx-auto max-w-3xl p-6"><SkeletonCard /></div>;
  if (!signal) return <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">Signal introuvable.</div>;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <DisclaimerBanner />

      <div className="flex items-center gap-3">
        <Link href="/signals">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Retour
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-semibold leading-tight">{signal.title}</h1>
          <p className="text-sm text-muted-foreground capitalize">
            {signal.category.replace(/_/g, ' ')} · {signal.severity} · confiance {signal.confidence}
          </p>
        </div>
      </div>

      {/* Signal metadata */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: 'Statut', value: signal.status },
          { label: 'Horizon', value: signal.impact_horizon?.replace(/_/g, ' ') ?? '—' },
          { label: 'Zones', value: signal.geographic_zones?.join(', ') || '—' },
          { label: 'Date', value: new Date(signal.occurred_at).toLocaleDateString('fr-FR') },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{kpi.label}</p>
            <p className="mt-0.5 text-sm font-medium capitalize">{kpi.value}</p>
          </div>
        ))}
      </div>

      {Boolean(signal.summary) && (
        <div className="rounded-lg border p-4">
          <p className="text-xs font-medium mb-1 text-muted-foreground">Synthèse</p>
          <p className="text-sm">{signal.summary as string}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline" size="sm"
          onClick={() => assessMutation.mutate(portfolioId)}
          disabled={assessMutation.isPending || !portfolioId}
        >
          <Cpu className="mr-1.5 h-4 w-4" />
          {assessMutation.isPending ? 'Analyse…' : 'Évaluer l\'impact'}
        </Button>
        <Button
          variant="outline" size="sm"
          onClick={() => analogsMutation.mutate()}
          disabled={analogsMutation.isPending}
        >
          <BookOpen className="mr-1.5 h-4 w-4" />
          {analogsMutation.isPending ? 'Recherche…' : 'Analogues historiques'}
        </Button>
        <Button
          variant="outline" size="sm"
          onClick={() => conclusionMutation.mutate(undefined, { onSuccess: (data) => setConclusion(data as SignalConclusion) })}
          disabled={conclusionMutation.isPending}
        >
          <FileText className="mr-1.5 h-4 w-4" />
          {conclusionMutation.isPending ? 'Génération…' : 'Générer une conclusion'}
        </Button>
      </div>

      {/* Impact result */}
      {assessMutation.isSuccess && (
        <div className="rounded-lg border p-4 text-sm">
          <p className="font-medium mb-2">Évaluation d'impact</p>
          <p className="text-xs text-muted-foreground">Impact évalué. Consultez la conclusion pour les détails structurés.</p>
        </div>
      )}

      {/* Analogs result */}
      {analogsMutation.isSuccess && Boolean(analogsMutation.data) && (
        <div className="rounded-lg border p-4 space-y-3">
          <p className="text-sm font-medium">Analogues historiques</p>
          {(analogsMutation.data as { analogs: { episodeTitle: string; similarityScore: number; contextDescription: string; resolution: string | null }[] }).analogs.map((a) => (
            <div key={a.episodeTitle} className="rounded bg-muted/40 p-3">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">{a.episodeTitle}</span>
                <span className="text-xs text-muted-foreground">Similarité : {Math.round(a.similarityScore * 100)}%</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{a.contextDescription}</p>
              {a.resolution && <p className="mt-1 text-xs italic text-muted-foreground">Issue : {a.resolution}</p>}
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground">Les analogues sont fournis à titre de contexte historique. Ils ne préjugent pas des évolutions futures.</p>
        </div>
      )}

      {/* Conclusion */}
      {conclusion && <ConclusionPanel conclusion={conclusion} />}
    </div>
  );
}
