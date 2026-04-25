'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { usePortfolios } from '@/hooks/use-portfolio';
import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';

interface RankedNewsItem {
  title: string;
  date: string;
  symbols: string[];
  sentiment: number | null;
  link: string | null;
  sourceDomain: string | null;
  provider: string;
  scores: {
    relevance: number;
    impact: number;
    freshness: number;
    source: number;
    convergence: number;
    final: number;
  };
  rationale: {
    relevance: string;
    impact: string;
    ageHours: number;
    sourceTier: 1 | 2 | 3;
    catalyst: string | null;
    isMacro: boolean;
    directHit: string | null;
    sectorHit: string | null;
    providers: string[];
  };
  replicaCount: number;
}

interface NewsAnalysisResponse {
  portfolioId: string;
  profile: string;
  halfLifeHours: number;
  heldSymbols: string[];
  providersStatus: Record<string, boolean>;
  sourcesFetched: Array<{ provider: string; count: number; ok: boolean; error?: string }>;
  elapsedMs: number;
  counts: {
    rawFetched: number;
    ranked: number;
    relevant: number;
    noise: number;
    discarded: number;
  };
  relevant: RankedNewsItem[];
  noise: RankedNewsItem[];
  discarded: RankedNewsItem[];
  briefingPreview: string;
}

export default function NewsAnalysisPage() {
  const { data: portfolios } = usePortfolios();
  const [portfolioId, setPortfolioId] = useState<string | null>(null);
  const [data, setData] = useState<NewsAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-select first paper portfolio
  useEffect(() => {
    if (!portfolioId && portfolios && portfolios.length > 0) {
      const paper = portfolios.find((p) => p.kind === 'paper') ?? portfolios[0];
      setPortfolioId(paper.id);
    }
  }, [portfolios, portfolioId]);

  const load = async () => {
    if (!portfolioId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<NewsAnalysisResponse>(`/lisa/news-analysis/${portfolioId}`);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Auto-load when portfolio is set
  useEffect(() => {
    if (portfolioId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolioId]);

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <BackButton label="Retour Lisa" />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">📰 News Analysis — pipeline Lisa en temps réel</h1>
        <Button onClick={load} disabled={loading || !portfolioId}>
          {loading ? 'Fetching...' : 'Refresh'}
        </Button>
      </div>

      {portfolios && portfolios.length > 1 && (
        <div className="flex gap-2 items-center">
          <label className="text-sm">Portfolio :</label>
          <select
            value={portfolioId ?? ''}
            onChange={(e) => setPortfolioId(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
          >
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ?? p.id.slice(0, 8)} ({p.kind})
              </option>
            ))}
          </select>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 p-3 rounded">
          <strong>Erreur :</strong> {error}
        </div>
      )}

      {data && (
        <>
          {/* Header stats */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
            <Stat label="Profile" value={data.profile} />
            <Stat label="Half-life" value={`${data.halfLifeHours}h`} />
            <Stat label="Latency" value={`${data.elapsedMs}ms`} />
            <Stat label="Held symbols" value={data.heldSymbols.join(', ') || '(none)'} />
            <Stat label="Total ranked" value={`${data.counts.ranked}`} />
          </div>

          {/* Providers status */}
          <div className="border rounded p-3 bg-slate-50">
            <h2 className="font-semibold mb-2">📡 Sources fetched</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              {data.sourcesFetched.map((s) => (
                <div
                  key={s.provider}
                  className={`p-2 rounded border ${
                    s.ok && s.count > 0
                      ? 'bg-green-50 border-green-200'
                      : s.ok
                      ? 'bg-slate-100 border-slate-200'
                      : 'bg-red-50 border-red-200'
                  }`}
                >
                  <div className="font-mono">{s.provider}</div>
                  <div className="text-lg font-bold">
                    {s.count} {s.ok ? '✓' : '✗'}
                  </div>
                  <div className="text-xs text-slate-500">
                    {data.providersStatus[s.provider] ? 'configured' : 'not configured'}
                  </div>
                  {s.error && <div className="text-xs text-red-600">{s.error.slice(0, 80)}</div>}
                </div>
              ))}
            </div>
          </div>

          {/* Counts */}
          <div className="border rounded p-3">
            <h2 className="font-semibold mb-2">Bucket distribution</h2>
            <div className="flex gap-4 text-sm">
              <span className="text-green-700">🟢 Pertinent: <strong>{data.counts.relevant}</strong></span>
              <span className="text-yellow-700">🟡 Bruit: <strong>{data.counts.noise}</strong></span>
              <span className="text-slate-500">⚫ Écarté: <strong>{data.counts.discarded}</strong></span>
            </div>
          </div>

          {/* Relevant news */}
          {data.relevant.length > 0 && (
            <div className="border rounded p-3">
              <h2 className="font-semibold mb-3 text-green-700">🟢 News pertinentes (score ≥ 50)</h2>
              <div className="space-y-2">
                {data.relevant.map((item, i) => (
                  <NewsCard key={i} item={item} />
                ))}
              </div>
            </div>
          )}

          {/* Noise */}
          {data.noise.length > 0 && (
            <details className="border rounded p-3">
              <summary className="cursor-pointer font-semibold text-yellow-700">
                🟡 Bruit ({data.noise.length})
              </summary>
              <div className="space-y-2 mt-3">
                {data.noise.slice(0, 10).map((item, i) => (
                  <NewsCard key={i} item={item} />
                ))}
              </div>
            </details>
          )}

          {/* Briefing preview */}
          <details className="border rounded p-3 bg-slate-900 text-slate-100">
            <summary className="cursor-pointer font-semibold">
              📜 Briefing exact envoyé à Claude Opus
            </summary>
            <pre className="mt-3 text-xs whitespace-pre-wrap font-mono">
              {data.briefingPreview}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border rounded p-2 bg-white">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="font-semibold truncate">{value}</div>
    </div>
  );
}

function NewsCard({ item }: { item: RankedNewsItem }) {
  const sent = item.sentiment;
  const sentLabel = sent !== null
    ? `${sent >= 0 ? '+' : ''}${(sent * 100).toFixed(0)}`
    : '?';
  const sentColor = sent === null ? 'text-slate-400'
    : sent > 0.2 ? 'text-green-600'
    : sent < -0.2 ? 'text-red-600'
    : 'text-slate-600';

  return (
    <div className="border-l-4 border-green-500 pl-3 py-2 bg-slate-50 rounded">
      <div className="flex items-start gap-2">
        <span className="font-bold text-lg text-green-700">[{item.scores.final}]</span>
        <div className="flex-1">
          <div className="font-medium">
            {item.link ? (
              <a href={item.link} target="_blank" rel="noopener noreferrer" className="hover:underline">
                {item.title}
              </a>
            ) : (
              item.title
            )}
          </div>
          <div className="text-xs text-slate-600 mt-1 flex flex-wrap gap-2">
            <span className="font-mono bg-slate-200 px-1 rounded">{item.provider}</span>
            {item.sourceDomain && <span>src={item.sourceDomain}</span>}
            <span>tier {item.rationale.sourceTier}</span>
            <span>age {item.rationale.ageHours}h</span>
            <span className={sentColor}>sent {sentLabel}</span>
            {item.rationale.directHit && (
              <span className="bg-blue-100 text-blue-800 px-1 rounded">💼 {item.rationale.directHit}</span>
            )}
            {item.rationale.sectorHit && (
              <span className="bg-purple-100 text-purple-800 px-1 rounded">🏷️ {item.rationale.sectorHit}</span>
            )}
            {item.rationale.isMacro && (
              <span className="bg-indigo-100 text-indigo-800 px-1 rounded">🌐 macro</span>
            )}
            {item.rationale.catalyst && (
              <span className="bg-orange-100 text-orange-800 px-1 rounded">⚡ {item.rationale.catalyst}</span>
            )}
            {item.replicaCount > 1 && (
              <span className="bg-slate-200 px-1 rounded">📡 ×{item.replicaCount}</span>
            )}
            {item.rationale.providers.length > 1 && (
              <span className="bg-pink-100 text-pink-800 px-1 rounded font-medium">
                🔀 {item.rationale.providers.join('+')} (+{item.scores.convergence})
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            scores: rel {item.scores.relevance} · impact {item.scores.impact} · fresh{' '}
            {item.scores.freshness} · source {item.scores.source}
            {item.scores.convergence > 0 && ` · conv +${item.scores.convergence}`}
          </div>
        </div>
      </div>
    </div>
  );
}
