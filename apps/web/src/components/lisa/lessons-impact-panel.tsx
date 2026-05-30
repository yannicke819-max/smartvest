'use client';

/**
 * LessonsImpactPanel — B.2, Lessons Impact Tracker.
 *
 * Affiche les lessons citées par TRADER sur une fenêtre glissante avec :
 *   - citations_count (combien de fois citée)
 *   - applied_count (combien de fois l'action a été appliquée)
 *   - win_rate / sum_pnl (outcome des positions issues de ces citations)
 *   - confidence + sample_size de la lesson (méta scanner_lessons)
 *
 * Filtres :
 *   - search (lesson_kind, lesson_text, marker)
 *   - window (7j / 30j / 90j / 1an)
 *   - "résolues seulement" (cache lessons sans outcome encore)
 *
 * Tri par citations_count DESC par défaut. Pagination client-side (20/page).
 * Design mobile-first : table compactée sur mobile (colonnes essentielles).
 */

import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { useLessonsImpact, type LessonImpactRow } from '@/hooks/use-lessons-impact';

interface Props {
  portfolioId: string;
}

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: '7j', days: 7 },
  { label: '30j', days: 30 },
  { label: '90j', days: 90 },
  { label: '1 an', days: 365 },
];

type SortKey = 'citations' | 'pnl' | 'win_rate' | 'last_cited';

const PAGE_SIZE = 20;

function fmtPnl(v: number): { txt: string; cls: string } {
  if (v === 0) return { txt: '$0', cls: 'text-muted-foreground' };
  const sign = v > 0 ? '+' : '-';
  return {
    txt: `${sign}$${Math.abs(v).toFixed(2)}`,
    cls: v > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
  };
}

function fmtPct(v: number | null): { txt: string; cls: string } {
  if (v === null) return { txt: '—', cls: 'text-muted-foreground' };
  return {
    txt: `${v.toFixed(0)}%`,
    cls: v >= 60 ? 'text-emerald-600 dark:text-emerald-400'
      : v >= 40 ? 'text-amber-600 dark:text-amber-400'
      : 'text-rose-600 dark:text-rose-400',
  };
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}j`;
}

export function LessonsImpactPanel({ portfolioId }: Props) {
  const [days, setDays] = useState(30);
  const [search, setSearch] = useState('');
  const [resolvedOnly, setResolvedOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('citations');
  const [page, setPage] = useState(0);

  const { data, isLoading, isError } = useLessonsImpact(portfolioId, days);

  const filtered = useMemo<LessonImpactRow[]>(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    let rows = data.lessons.filter((l) => {
      if (resolvedOnly && l.resolved_count === 0) return false;
      if (!q) return true;
      return (
        l.lesson_kind.toLowerCase().includes(q)
        || (l.lesson_text ?? '').toLowerCase().includes(q)
        || l.marker_text.toLowerCase().includes(q)
      );
    });
    rows = [...rows].sort((a, b) => {
      switch (sortKey) {
        case 'citations': return b.citations_count - a.citations_count;
        case 'pnl': return b.sum_pnl_usd - a.sum_pnl_usd;
        case 'win_rate':
          return (b.win_rate_pct ?? -1) - (a.win_rate_pct ?? -1);
        case 'last_cited':
          return (b.last_cited_at ?? '').localeCompare(a.last_cited_at ?? '');
      }
    });
    return rows;
  }, [data, search, resolvedOnly, sortKey]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            📚 Lessons Impact Tracker
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Citations de lessons par TRADER + outcome des trades issus de ces citations.
          </p>
        </div>
        {data && (
          <div className="text-[11px] text-muted-foreground">
            {data.totalCitations} citations · {data.resolvedCitations} résolues
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input
          type="text"
          placeholder="Search lesson_kind / text / marker"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          className="flex-1 min-w-[180px] rounded border px-2 py-1.5 text-xs bg-background"
        />
        <select
          value={days}
          onChange={(e) => { setDays(Number(e.target.value)); setPage(0); }}
          className="rounded border px-2 py-1.5 text-xs bg-background"
        >
          {WINDOWS.map((w) => (
            <option key={w.days} value={w.days}>{w.label}</option>
          ))}
        </select>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="rounded border px-2 py-1.5 text-xs bg-background"
        >
          <option value="citations">Tri: citations</option>
          <option value="pnl">Tri: P&amp;L</option>
          <option value="win_rate">Tri: win-rate</option>
          <option value="last_cited">Tri: récence</option>
        </select>
        <label className="flex items-center gap-1.5 text-[11px] cursor-pointer">
          <input
            type="checkbox"
            checked={resolvedOnly}
            onChange={(e) => setResolvedOnly(e.target.checked)}
            className="accent-primary"
          />
          Résolues uniquement
        </label>
      </div>

      {isLoading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-pulse h-12 bg-muted rounded" />
          ))}
        </div>
      )}

      {isError && (
        <div className="text-xs text-rose-600 dark:text-rose-400">
          Erreur de chargement.
        </div>
      )}

      {!isLoading && !isError && filtered.length === 0 && (
        <div className="text-xs text-muted-foreground py-6 text-center">
          Aucune citation sur cette fenêtre. TRADER citera des lessons en
          insérant <code className="bg-muted px-1 rounded">[MARKER]</code> dans
          ses thèses.
        </div>
      )}

      {!isLoading && pageRows.length > 0 && (
        <>
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase text-muted-foreground border-b">
                <tr>
                  <th className="text-left py-1.5 pr-2">Lesson</th>
                  <th className="text-right py-1.5 px-2">Cit.</th>
                  <th className="text-right py-1.5 px-2 hidden sm:table-cell">Appl.</th>
                  <th className="text-right py-1.5 px-2 hidden sm:table-cell">W/L</th>
                  <th className="text-right py-1.5 px-2">Win%</th>
                  <th className="text-right py-1.5 px-2">PnL</th>
                  <th className="text-right py-1.5 pl-2 hidden md:table-cell">Conf.</th>
                  <th className="text-right py-1.5 pl-2 hidden md:table-cell">Last</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pageRows.map((l, i) => {
                  const pnl = fmtPnl(l.sum_pnl_usd);
                  const wr = fmtPct(l.win_rate_pct);
                  const isOrphan = l.lesson_id === null;
                  return (
                    <tr key={`${l.lesson_id ?? l.marker_text}-${i}`} className="hover:bg-muted/40">
                      <td className="py-2 pr-2 max-w-[280px]">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <code className={`text-[10px] px-1.5 py-0.5 rounded ${
                            isOrphan ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
                              : 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300'
                          }`}>
                            {l.marker_text}
                          </code>
                          {l.is_active === false && (
                            <span className="text-[9px] uppercase text-muted-foreground">inactive</span>
                          )}
                        </div>
                        {l.lesson_text && (
                          <div className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">
                            {l.lesson_text}
                          </div>
                        )}
                        {isOrphan && (
                          <div className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
                            Marker non mappé à scanner_lessons
                          </div>
                        )}
                      </td>
                      <td className="text-right py-2 px-2 font-semibold tabular-nums">{l.citations_count}</td>
                      <td className="text-right py-2 px-2 tabular-nums hidden sm:table-cell">{l.applied_count}</td>
                      <td className="text-right py-2 px-2 tabular-nums hidden sm:table-cell text-[11px]">
                        <span className="text-emerald-600 dark:text-emerald-400">{l.wins}</span>
                        /<span className="text-rose-600 dark:text-rose-400">{l.losses}</span>
                      </td>
                      <td className={`text-right py-2 px-2 tabular-nums font-semibold ${wr.cls}`}>{wr.txt}</td>
                      <td className={`text-right py-2 px-2 tabular-nums font-semibold ${pnl.cls}`}>{pnl.txt}</td>
                      <td className="text-right py-2 pl-2 tabular-nums hidden md:table-cell text-muted-foreground">
                        {l.confidence !== null ? l.confidence.toFixed(2) : '—'}
                      </td>
                      <td className="text-right py-2 pl-2 hidden md:table-cell text-muted-foreground">
                        {fmtAge(l.last_cited_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-3 text-xs">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-2 py-1 rounded border disabled:opacity-40"
              >
                ←
              </button>
              <span className="text-muted-foreground">
                Page {page + 1} / {totalPages} ({filtered.length} lessons)
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-2 py-1 rounded border disabled:opacity-40"
              >
                →
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
