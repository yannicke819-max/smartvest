'use client';

import { useState } from 'react';
import { CheckCircle2, XCircle, ChevronDown, ChevronUp, AlertTriangle, TrendingUp, TrendingDown, Search, Play, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  useApproveProposal,
  useRejectProposal,
  type LisaProposalRow,
} from '@/hooks/use-lisa';

interface Thesis {
  id: string;
  title: string;
  summary: string;
  catalyst: string;
  whoIsWrong: string;
  category: string;
  confidenceScore: number;
  expressions: Array<{
    symbol: string;
    name: string;
    assetClass: string;
    direction: string;
    preferredVenue: string;
    whyThisExpression: string;
  }>;
  preferredExpressionIndex: number;
  expressionChoiceRationale: string;
  riskReward: {
    centralScenarioReturnPct: { low: number; mid: number; high: number };
    adverseScenarioReturnPct: number;
    riskRewardRatio: number;
    horizonDays: number;
    convexitySources: string[];
  };
  invalidation: {
    conditions: Array<{
      description: string;
      metricType: string;
      thresholdValue: string | null;
      thresholdDirection: string | null;
    }>;
    qualitativeConditions: string[];
  };
  antiBullshit: {
    isCrowded: boolean;
    isCrowdedRationale: string;
    driverType: string;
    evidenceType: string;
    selfCritique: string;
  };
  analogSlugs: string[];
}

const CATEGORY_LABELS: Record<string, string> = {
  hidden_gem: 'Pépite cachée',
  turnaround: 'Retournement',
  flow_timing: 'Flow / Timing',
  watchlist: 'Surveillance',
  contrarian: 'Contrarian',
  mean_reversion: 'Mean reversion',
  event_driven: 'Event-driven',
};

const STATUS_STYLE: Record<LisaProposalRow['status'], string> = {
  draft: 'bg-slate-100 text-slate-700',
  proposed: 'bg-blue-50 text-blue-700 border-blue-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-slate-50 text-slate-500 border-slate-200',
  executed: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  expired: 'bg-amber-50 text-amber-700 border-amber-200',
};

export function LisaProposalCard({
  proposal,
  portfolioId,
}: {
  proposal: LisaProposalRow;
  portfolioId: string;
}) {
  const [expanded, setExpanded] = useState(proposal.status === 'proposed');
  const [showAllTheses, setShowAllTheses] = useState(false);
  const approve = useApproveProposal(portfolioId);
  const reject = useRejectProposal(portfolioId);

  const theses = proposal.theses as unknown as Thesis[];
  const thesesToShow = showAllTheses ? theses : theses.slice(0, 2);

  async function handleApprove() {
    if (!confirm(`Ouvrir ${proposal.allocations.length} position(s) en simulation ?`)) return;
    await approve.mutateAsync(proposal.id);
  }

  async function handleReject() {
    const reason = prompt('Raison du rejet (optionnel) :') ?? 'Rejet utilisateur';
    await reject.mutateAsync({ proposalId: proposal.id, reason });
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-start justify-between p-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[proposal.status]}`}>
              {proposal.status}
            </span>
            <span className="text-xs text-muted-foreground">
              {new Date(proposal.generated_at).toLocaleString('fr-FR')}
            </span>
            {proposal.claude_cost_usd != null && (
              <span className="text-xs text-muted-foreground">
                · Coût API : ${proposal.claude_cost_usd.toFixed(4)}
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <span className="text-xs rounded bg-primary/10 text-primary px-2 py-0.5 font-medium uppercase tracking-wide">
              {proposal.detected_regime}
            </span>
            {proposal.market_momentum && proposal.market_momentum !== 'neutral' && (
              <span
                className={`text-xs rounded px-2 py-0.5 font-medium uppercase tracking-wide ${
                  proposal.market_momentum === 'bullish_strong'
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-rose-100 text-rose-700'
                }`}
                title={
                  proposal.market_momentum === 'bullish_strong'
                    ? 'Momentum haussier confirmé — cap d\'ouvertures élargi, cooldown levé'
                    : 'Momentum baissier — cap serré, cooldown rallongé'
                }
              >
                {proposal.market_momentum === 'bullish_strong' ? '▲ bullish strong' : '▼ bearish'}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {theses.length} thèse(s) · Capital {proposal.capital_usd} {proposal.base_currency}
            </span>
          </div>
          <p className="mt-2 text-sm line-clamp-2">{proposal.regime_summary}</p>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="ml-2 rounded p-1 hover:bg-muted"
          aria-label={expanded ? 'Réduire' : 'Développer'}
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {expanded && (
        <div className="border-t p-4 space-y-4">
          {/* Lisa v2 — blocs structurés [DIAGNOSTIC] / [PLAN] / [CONDITIONS] */}
          {(() => {
            const STRUCTURED_RE = /^\[(DIAGNOSTIC|PLAN|CONDITIONS)\]\s*(.+)$/s;
            const structured: Record<'DIAGNOSTIC' | 'PLAN' | 'CONDITIONS', string | null> = {
              DIAGNOSTIC: null,
              PLAN: null,
              CONDITIONS: null,
            };
            const others: string[] = [];
            for (const w of proposal.warnings) {
              const m = STRUCTURED_RE.exec(w);
              if (m) {
                const key = m[1] as 'DIAGNOSTIC' | 'PLAN' | 'CONDITIONS';
                if (structured[key] === null) structured[key] = m[2].trim();
                else others.push(w);
              } else {
                others.push(w);
              }
            }
            const hasAllThree = structured.DIAGNOSTIC && structured.PLAN && structured.CONDITIONS;

            return (
              <>
                {hasAllThree && (
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                    <section className="rounded-md border border-sky-200 bg-sky-50 p-3 text-xs space-y-1">
                      <header className="flex items-center gap-1 font-semibold text-sky-800 uppercase tracking-wide">
                        <Search className="h-3 w-3" /> Diagnostic
                      </header>
                      <p className="text-sky-900 leading-relaxed">{structured.DIAGNOSTIC}</p>
                    </section>
                    <section className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs space-y-1">
                      <header className="flex items-center gap-1 font-semibold text-emerald-800 uppercase tracking-wide">
                        <Play className="h-3 w-3" /> Plan
                      </header>
                      <p className="text-emerald-900 leading-relaxed">{structured.PLAN}</p>
                    </section>
                    <section className="rounded-md border border-violet-200 bg-violet-50 p-3 text-xs space-y-1">
                      <header className="flex items-center gap-1 font-semibold text-violet-800 uppercase tracking-wide">
                        <AlertCircle className="h-3 w-3" /> Conditions
                      </header>
                      <p className="text-violet-900 leading-relaxed">{structured.CONDITIONS}</p>
                    </section>
                  </div>
                )}

                {/* Autres warnings (après les 3 blocs ou en fallback si préfixes absents) */}
                {(hasAllThree ? others : proposal.warnings).length > 0 && (
                  <div className="rounded-md border-amber-200 bg-amber-50 border p-3 text-xs space-y-1">
                    <div className="flex items-center gap-1 font-medium text-amber-800">
                      <AlertTriangle className="h-3 w-3" />
                      {hasAllThree ? 'Autres warnings' : 'Warnings'}
                    </div>
                    {(hasAllThree ? others : proposal.warnings).map((w, i) => (
                      <p key={i} className="text-amber-700">· {w}</p>
                    ))}
                  </div>
                )}
              </>
            );
          })()}

          {/* Favored / Avoided */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium text-emerald-700 mb-1 flex items-center gap-1">
                <TrendingUp className="h-3 w-3" /> Poches favorisées
              </p>
              <ul className="space-y-1">
                {proposal.favored_pockets.map((p, i) => (
                  <li key={i} className="text-xs text-muted-foreground">
                    <span className="font-medium">{p.assetClass}</span> — {p.rationale}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1 flex items-center gap-1">
                <TrendingDown className="h-3 w-3" /> Poches évitées
              </p>
              <ul className="space-y-1">
                {proposal.avoided_pockets.map((p, i) => (
                  <li key={i} className="text-xs text-muted-foreground">
                    <span className="font-medium">{p.assetClass}</span> — {p.rationale}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Theses */}
          <div>
            <p className="text-xs font-medium mb-2">Thèses proposées</p>
            <div className="space-y-3">
              {thesesToShow.map((t, _tIdx) => {
                const alloc = proposal.allocations.find((a) => a.thesisId === t.id);
                const expr = t.expressions[t.preferredExpressionIndex];
                const rr = t.riskReward.centralScenarioReturnPct;
                return (
                  <div key={t.id} className="rounded border p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] uppercase bg-muted rounded px-1.5 py-0.5 text-muted-foreground">
                            {CATEGORY_LABELS[t.category] ?? t.category}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            Confidence : {t.confidenceScore}/100
                          </span>
                        </div>
                        <h3 className="text-sm font-medium mt-1">{t.title}</h3>
                      </div>
                      {alloc && (
                        <div className="text-right flex-shrink-0">
                          <div className="text-sm font-semibold">{alloc.pctCapital}%</div>
                          <div className="text-[10px] text-muted-foreground">{alloc.amountUsd} USD</div>
                        </div>
                      )}
                    </div>

                    <p className="text-xs text-muted-foreground leading-relaxed">{t.summary}</p>

                    {expr && (
                      <div className="rounded bg-muted/40 p-2 text-xs space-y-0.5">
                        <div className="font-medium">
                          {expr.direction} {expr.symbol} ({expr.name}) · {expr.assetClass}
                        </div>
                        <div className="text-muted-foreground">
                          Venue : {expr.preferredVenue}
                        </div>
                        <div className="text-muted-foreground">
                          {expr.whyThisExpression}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <div className="text-[10px] text-muted-foreground">Central</div>
                        <div className="font-medium text-emerald-700">
                          {rr.low.toFixed(1)}% / {rr.mid.toFixed(1)}% / {rr.high.toFixed(1)}%
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted-foreground">Adverse</div>
                        <div className="font-medium text-red-600">
                          {t.riskReward.adverseScenarioReturnPct.toFixed(1)}%
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted-foreground">R/R · Horizon</div>
                        <div className="font-medium">
                          {t.riskReward.riskRewardRatio.toFixed(1)}x · {t.riskReward.horizonDays}j
                        </div>
                      </div>
                    </div>

                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        Invalidation + anti-bullshit + analogs
                      </summary>
                      <div className="mt-2 space-y-2 border-l-2 border-muted pl-3">
                        <div>
                          <p className="font-medium text-[11px] mb-1">Conditions d'invalidation</p>
                          <ul className="space-y-0.5 text-muted-foreground">
                            {t.invalidation.conditions.map((c, i) => (
                              <li key={i}>
                                · {c.description} ({c.metricType}
                                {c.thresholdValue ? ` ${c.thresholdDirection} ${c.thresholdValue}` : ''})
                              </li>
                            ))}
                            {t.invalidation.qualitativeConditions.map((q, i) => (
                              <li key={`q${i}`} className="italic">· {q}</li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <p className="font-medium text-[11px] mb-1">Anti-bullshit check</p>
                          <p className="text-muted-foreground">
                            Crowded : <span className="font-medium">{t.antiBullshit.isCrowded ? 'oui' : 'non'}</span> — {t.antiBullshit.isCrowdedRationale}
                          </p>
                          <p className="text-muted-foreground">
                            Driver : <span className="font-medium">{t.antiBullshit.driverType}</span> · Evidence : <span className="font-medium">{t.antiBullshit.evidenceType}</span>
                          </p>
                          <p className="text-muted-foreground italic mt-1">
                            Auto-critique : {t.antiBullshit.selfCritique}
                          </p>
                        </div>
                        {t.analogSlugs.length > 0 && (
                          <div>
                            <p className="font-medium text-[11px] mb-1">Analogs historiques</p>
                            <div className="flex flex-wrap gap-1">
                              {t.analogSlugs.map((s) => (
                                <code key={s} className="text-[10px] bg-muted px-1.5 py-0.5 rounded">
                                  {s}
                                </code>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </details>
                  </div>
                );
              })}
            </div>

            {theses.length > 2 && (
              <button
                onClick={() => setShowAllTheses((v) => !v)}
                className="mt-2 text-xs text-primary hover:underline"
              >
                {showAllTheses ? 'Réduire' : `Afficher les ${theses.length - 2} autres thèses…`}
              </button>
            )}
          </div>

          {/* Actions */}
          {proposal.status === 'proposed' && (
            <div className="flex gap-2 pt-2 border-t">
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={approve.isPending || reject.isPending}
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                {approve.isPending ? 'Ouverture…' : 'Approuver & ouvrir positions'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleReject}
                disabled={approve.isPending || reject.isPending}
              >
                <XCircle className="mr-1.5 h-4 w-4" />
                Rejeter
              </Button>
            </div>
          )}

          {(proposal.status === 'approved' || proposal.status === 'executed') && (
            <div className="flex items-center gap-2 pt-2 border-t">
              <Button size="sm" disabled className="cursor-not-allowed opacity-60">
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                Approuvé &amp; positions ouvertes
              </Button>
              {proposal.executed_at && (
                <span className="text-xs text-muted-foreground">
                  le {new Date(proposal.executed_at).toLocaleString('fr-FR', {
                    day: '2-digit', month: '2-digit', year: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
