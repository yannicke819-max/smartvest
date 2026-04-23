'use client';

import { useMemo, useState } from 'react';
import { Activity, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { LisaProposalCard } from '@/components/lisa/proposal-card';
import { usePurgeOldProposals, type LisaProposalRow } from '@/hooks/use-lisa';

/**
 * Groupe les propositions Lisa par jour calendaire (UTC).
 *
 * Par défaut, TOUTES les sections sont repliées (y compris "Aujourd'hui").
 * L'utilisateur déplie manuellement ce qu'il veut consulter. Aucune
 * persistance entre refreshs : chaque rechargement de page repart avec
 * tout replié — comportement explicitement demandé.
 */
export function LisaProposalsGroupedByDay({
  proposals,
  portfolioId,
  isLoading,
}: {
  proposals: LisaProposalRow[];
  portfolioId: string;
  isLoading: boolean;
}) {
  const purge = usePurgeOldProposals(portfolioId);
  // Set des jours dépliés. Vide au mount → tout replié.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => {
    const buckets = new Map<string, { key: string; label: string; items: LisaProposalRow[] }>();
    const today = dayKey(new Date());
    const yesterday = dayKey(new Date(Date.now() - 86_400_000));

    for (const p of proposals) {
      const d = new Date(p.generated_at);
      const key = dayKey(d);
      if (!buckets.has(key)) {
        let label: string;
        if (key === today) label = "Aujourd'hui";
        else if (key === yesterday) label = 'Hier';
        else label = d.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long' });
        buckets.set(key, { key, label, items: [] });
      }
      buckets.get(key)!.items.push(p);
    }

    return Array.from(buckets.values()).sort((a, b) => b.key.localeCompare(a.key));
  }, [proposals]);

  const totalCount = proposals.length;

  const isExpanded = (key: string) => expanded.has(key);

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  async function handlePurge() {
    if (!portfolioId) return;
    if (!confirm(
      'Supprimer les propositions terminales (approuvées / rejetées / expirées) '
      + 'ET les propositions de plus de 24h ?\n\n'
      + 'Les propositions récentes en attente d\'approbation sont préservées.',
    )) return;
    const { deleted } = await purge.mutateAsync(24);
    alert(`${deleted} proposition(s) supprimée(s).`);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Propositions Lisa</h2>
        <span className="text-xs text-muted-foreground">
          ({totalCount} au total · {grouped.length} jour{grouped.length > 1 ? 's' : ''})
        </span>
        {totalCount > 5 && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={handlePurge}
            disabled={purge.isPending}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {purge.isPending ? 'Purge…' : 'Purger anciennes'}
          </Button>
        )}
      </div>

      {isLoading && <SkeletonCard />}

      {!isLoading && totalCount === 0 && (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Aucune proposition. Active l'autopilot ou clique "Générer propositions" manuellement.
        </div>
      )}

      {grouped.map((group) => {
        const open = isExpanded(group.key);
        return (
          <div key={group.key} className="rounded-lg border">
            <button
              type="button"
              onClick={() => toggleExpanded(group.key)}
              className="w-full flex items-center justify-between gap-2 px-4 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
            >
              <div className="flex items-center gap-2">
                {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                <span className="text-sm font-medium capitalize">{group.label}</span>
                <span className="text-xs text-muted-foreground">
                  · {group.items.length} proposition{group.items.length > 1 ? 's' : ''}
                </span>
              </div>
              <span className="text-[10px] font-mono text-muted-foreground">
                {countByStatus(group.items)}
              </span>
            </button>
            {open && (
              <div className="p-3 space-y-2">
                {group.items.map((p) => (
                  <LisaProposalCard key={p.id} proposal={p} portfolioId={portfolioId} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function countByStatus(items: LisaProposalRow[]): string {
  const counts: Record<string, number> = {};
  for (const p of items) counts[p.status] = (counts[p.status] ?? 0) + 1;
  const parts: string[] = [];
  if (counts.proposed) parts.push(`${counts.proposed} en attente`);
  if (counts.executed) parts.push(`${counts.executed} exécutées`);
  if (counts.rejected) parts.push(`${counts.rejected} rejetées`);
  if (counts.expired) parts.push(`${counts.expired} expirées`);
  return parts.join(' · ');
}
