'use client';

/**
 * CoachProposalsPanel — C.2, UI review pour Strategy Coach proposals.
 *
 * - Liste les coach_proposals status='pending' du portfolio
 * - Chaque carte expandable → modal review
 * - Modal : verdict + rationale + lessons (checkbox par item) + params
 *   (checkbox par item) + commentaire + boutons Accept/Reject
 * - Accept partiel = lessons/params sélectionnés UNIQUEMENT créés
 * - Reject = toutes les sélections vides
 *
 * Design : mobile-first (modal bottom sheet < md, centré ≥ md).
 */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  useCoachProposals,
  useAcceptCoachProposal,
  useRejectCoachProposal,
  type CoachProposal,
} from '@/hooks/use-coach-proposals';

interface Props {
  portfolioId: string;
}

function verdictBadge(v: string): { txt: string; cls: string } {
  switch (v) {
    case 'REACHABLE':
      return { txt: 'Atteignable', cls: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' };
    case 'NEEDS_CHANGES':
      return { txt: 'Ajustements requis', cls: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' };
    case 'UNREALISTIC':
      return { txt: 'Irréaliste', cls: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300' };
    default:
      return { txt: v, cls: 'bg-muted text-muted-foreground' };
  }
}

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours}h`;
  return `il y a ${Math.floor(hours / 24)}j`;
}

export function CoachProposalsPanel({ portfolioId }: Props) {
  const { data: proposals, isLoading } = useCoachProposals(portfolioId, 'pending');
  const [reviewing, setReviewing] = useState<CoachProposal | null>(null);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            🧠 Strategy Coach
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Propositions Gemini Pro (hourly) — review et applique les lessons qui te conviennent.
          </p>
        </div>
        {proposals && proposals.length > 0 && (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-semibold">
            {proposals.length} en attente
          </span>
        )}
      </div>

      {isLoading && (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="animate-pulse h-16 bg-muted rounded" />
          ))}
        </div>
      )}

      {!isLoading && (!proposals || proposals.length === 0) && (
        <div className="text-xs text-muted-foreground py-6 text-center">
          Aucune proposition en attente. Strategy Coach analyse l'activité chaque heure.
        </div>
      )}

      {!isLoading && proposals && proposals.length > 0 && (
        <div className="space-y-2">
          {proposals.map((p) => {
            const v = verdictBadge(p.feasibility_verdict);
            return (
              <button
                type="button"
                key={p.id}
                onClick={() => setReviewing(p)}
                className="w-full text-left rounded-lg border p-3 hover:bg-muted/40 transition"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${v.cls} font-semibold`}>
                      {v.txt}
                    </span>
                    {p.feasibility_probability_pct !== null && (
                      <span className="text-[10px] text-muted-foreground">
                        {p.feasibility_probability_pct.toFixed(0)}%
                      </span>
                    )}
                    <code className="text-[10px] text-muted-foreground">{p.llm_model}</code>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{fmtAge(p.created_at)}</span>
                </div>
                <p className="text-xs line-clamp-2">{p.feasibility_rationale}</p>
                <div className="text-[11px] text-muted-foreground mt-1">
                  {p.proposed_lessons.length} lesson(s) · {p.proposed_parameter_changes.length} param(s)
                  {p.risk_warnings.length > 0 && ` · ⚠️ ${p.risk_warnings.length} warning(s)`}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {reviewing && (
        <ReviewModal proposal={reviewing} onClose={() => setReviewing(null)} />
      )}
    </Card>
  );
}

function ReviewModal({ proposal, onClose }: { proposal: CoachProposal; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [acceptedLessons, setAcceptedLessons] = useState<Set<number>>(new Set());
  const [acceptedParams, setAcceptedParams] = useState<Set<number>>(new Set());
  const [comment, setComment] = useState('');
  const accept = useAcceptCoachProposal();
  const reject = useRejectCoachProposal();

  // Mount portal (avoid SSR hydration mismatch)
  if (typeof window !== 'undefined' && !mounted) setMounted(true);
  if (!mounted) return null;

  const toggleLesson = (i: number) => {
    setAcceptedLessons((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };
  const toggleParam = (i: number) => {
    setAcceptedParams((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const onAccept = async () => {
    await accept.mutateAsync({
      id: proposal.id,
      accepted_lessons: [...acceptedLessons],
      accepted_params: [...acceptedParams],
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
    onClose();
  };
  const onReject = async () => {
    await reject.mutateAsync({
      id: proposal.id,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
    onClose();
  };

  const v = verdictBadge(proposal.feasibility_verdict);
  const isPending = accept.isPending || reject.isPending;
  const nothingSelected = acceptedLessons.size === 0 && acceptedParams.size === 0;

  const content = (
    <>
      <button
        type="button"
        onClick={onClose}
        className="fixed inset-0 bg-black/50 z-40"
        aria-label="Fermer"
      />
      <div
        className="fixed z-50 bg-card border shadow-xl flex flex-col
                   md:rounded-lg md:max-w-2xl md:max-h-[85vh] md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-[calc(100vw-2rem)]
                   max-md:inset-x-0 max-md:bottom-0 max-md:top-8 max-md:rounded-t-2xl"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <h3 className="text-sm font-semibold">🧠 Review proposition</h3>
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${v.cls} font-semibold`}>{v.txt}</span>
            {proposal.feasibility_probability_pct !== null && (
              <span className="text-[10px] text-muted-foreground">
                {proposal.feasibility_probability_pct.toFixed(0)}%
              </span>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" className="text-muted-foreground text-xl px-1">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* Rationale */}
          <div className="rounded-md bg-muted/40 p-3">
            <div className="text-[10px] uppercase text-muted-foreground mb-1">Rationale</div>
            <p className="text-xs">{proposal.feasibility_rationale}</p>
          </div>

          {/* Risk warnings */}
          {proposal.risk_warnings.length > 0 && (
            <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3">
              <div className="text-[10px] uppercase text-amber-700 dark:text-amber-300 mb-1 font-semibold">⚠️ Risk warnings</div>
              <ul className="text-xs space-y-1 list-disc pl-4">
                {proposal.risk_warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          {/* Lessons */}
          {proposal.proposed_lessons.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-2">
                📚 Lessons proposées ({acceptedLessons.size}/{proposal.proposed_lessons.length} acceptées)
              </div>
              <div className="space-y-2">
                {proposal.proposed_lessons.map((l, i) => (
                  <label
                    key={i}
                    className={`block rounded border p-2 cursor-pointer ${
                      acceptedLessons.has(i) ? 'border-purple-400 bg-purple-50 dark:bg-purple-950/20' : ''
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={acceptedLessons.has(i)}
                        onChange={() => toggleLesson(i)}
                        className="accent-purple-600 h-4 w-4 mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <code className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300">
                            {l.lesson_kind}
                          </code>
                          <span className="text-[10px] text-muted-foreground">conf {l.confidence.toFixed(2)}</span>
                          <span className="text-[10px] text-muted-foreground">{l.scope}</span>
                          {l.expected_impact_usd !== undefined && (
                            <span className="text-[10px] font-semibold">
                              impact {l.expected_impact_usd >= 0 ? '+' : ''}${l.expected_impact_usd}
                            </span>
                          )}
                        </div>
                        <p className="text-xs mt-1">{l.lesson_text}</p>
                        {l.rationale && (
                          <p className="text-[11px] text-muted-foreground mt-1 italic">
                            {l.rationale}
                          </p>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Params (info only — accept enregistre l'intention dans user_decision) */}
          {proposal.proposed_parameter_changes.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-2">
                ⚙️ Changements de paramètres ({acceptedParams.size}/{proposal.proposed_parameter_changes.length})
              </div>
              <p className="text-[11px] text-muted-foreground mb-2">
                Coche les params à appliquer. Note : les changements sont logués dans user_decision
                mais doivent être appliqués manuellement (Fly secrets ou Config UI).
              </p>
              <div className="space-y-2">
                {proposal.proposed_parameter_changes.map((p, i) => (
                  <label
                    key={i}
                    className={`block rounded border p-2 cursor-pointer ${
                      acceptedParams.has(i) ? 'border-purple-400 bg-purple-50 dark:bg-purple-950/20' : ''
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={acceptedParams.has(i)}
                        onChange={() => toggleParam(i)}
                        className="accent-purple-600 h-4 w-4 mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <code className="text-[11px] font-semibold">{p.param}</code>
                        <div className="text-[11px] text-muted-foreground">
                          {String(p.current)} → <strong>{String(p.proposed)}</strong>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-1 italic">{p.rationale}</p>
                        {p.expected_impact && (
                          <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5">
                            Impact attendu : {p.expected_impact}
                          </p>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Comment */}
          <div>
            <label className="text-xs font-semibold mb-1 block">Commentaire (optionnel)</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Note pour le journal de décision…"
              className="w-full rounded border px-2 py-1.5 text-xs bg-background"
              rows={2}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t flex items-center justify-end gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={onClose} disabled={isPending}>
            Annuler
          </Button>
          <Button variant="destructive" size="sm" onClick={onReject} disabled={isPending}>
            {reject.isPending ? '…' : 'Rejeter'}
          </Button>
          <Button
            size="sm"
            onClick={onAccept}
            disabled={isPending || nothingSelected}
          >
            {accept.isPending ? '…' : (nothingSelected ? 'Coche au moins 1 item' : `Accepter (${acceptedLessons.size}L + ${acceptedParams.size}P)`)}
          </Button>
        </div>
      </div>
    </>
  );

  return createPortal(content, document.body);
}
