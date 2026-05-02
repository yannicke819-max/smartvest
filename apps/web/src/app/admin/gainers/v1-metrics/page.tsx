/**
 * /admin/gainers/v1-metrics — Step 10 dashboard observability (ADR-005).
 *
 * Source : GET /admin/gainers/v1-metrics (header x-admin-token).
 *
 * UI minimal MVP (cards shadcn). Refonte Tremor + Recharts riches dans le
 * chantier S-DESIGN-V2 chantier C (mission B+C).
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Activity, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface BucketMetrics {
  totalScanned: number;
  accepted: number;
  rejected: number;
  acceptRatePct: number;
}

interface MetricsResponse {
  asOf: string;
  timeBuckets: { last_24h: BucketMetrics; last_7d: BucketMetrics; last_30d: BucketMetrics };
  rejectBreakdown: Array<{ reason: string; count: number; pct: number }>;
  topRejects: Array<{ symbol: string; reason: string; count: number }>;
  compositeScoreHistogram: Array<{ bucket: string; count: number }>;
  signalCadence: Array<{ date: string; accept: number; reject: number }>;
  recentCandidates: Array<{
    ts: string;
    symbol: string;
    market: string;
    score: number | null;
    decision: 'ACCEPT' | 'REJECT';
    trigger: string | null;
    rejectReason: string | null;
  }>;
  positionsHealth: {
    open: number;
    closedTpFull: number;
    closedSl: number;
    closedTrailing20Hit: number;
    closedTrailing50Hit: number;
    closedStructureBreak: number;
    avgRealizedPnlPct: number | null;
    avgSlippagePct: number | null;
    anomalousFillCount: number;
  };
  etlHealth: {
    baselineCount: number;
    baselineFreshnessHours: number | null;
    legacySnapshotCount: number;
  };
}

function pct(n: number | null): string {
  return n === null ? '—' : `${(n * 100).toFixed(2)}%`;
}

function BucketCard({ label, b }: { label: string; b: BucketMetrics }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{b.totalScanned}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        ✓ {b.accepted} · ✗ {b.rejected} · accept rate <span className="font-medium">{b.acceptRatePct}%</span>
      </div>
    </Card>
  );
}

export default function GainersMetricsPage() {
  const [token, setToken] = useState<string>('');
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    if (!token) {
      setError('admin token requis');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/admin/gainers/v1-metrics`, {
        headers: { 'x-admin-token': token },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  // load token from localStorage on mount
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('smartvest_admin_token') : null;
    if (saved) setToken(saved);
  }, []);

  const saveToken = (t: string) => {
    setToken(t);
    if (typeof window !== 'undefined') window.localStorage.setItem('smartvest_admin_token', t);
  };

  return (
    <div className="container mx-auto max-w-6xl space-y-6 p-6">
      <BackButton label="Retour" />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Gainers V1 — observability</h1>
        <Button onClick={fetchMetrics} disabled={loading || !token} size="sm">
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <Card className="p-4">
        <label className="text-xs font-medium">Admin token</label>
        <input
          type="password"
          value={token}
          onChange={(e) => saveToken(e.target.value)}
          placeholder="x-admin-token"
          className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
        />
        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
      </Card>

      {data && (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <BucketCard label="Last 24h" b={data.timeBuckets.last_24h} />
            <BucketCard label="Last 7 days" b={data.timeBuckets.last_7d} />
            <BucketCard label="Last 30 days" b={data.timeBuckets.last_30d} />
          </div>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">Reject breakdown</h2>
            <div className="space-y-1">
              {data.rejectBreakdown.length === 0 ? (
                <div className="text-xs text-muted-foreground">Pas de rejets sur la fenêtre.</div>
              ) : (
                data.rejectBreakdown.map((r) => (
                  <div key={r.reason} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-xs">{r.reason}</span>
                    <span className="text-muted-foreground">
                      {r.count} ({r.pct}%)
                    </span>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">Positions health</h2>
            <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
              <div><span className="text-muted-foreground">Open: </span>{data.positionsHealth.open}</div>
              <div><TrendingUp className="inline h-3 w-3 text-emerald-500" /> TP full: {data.positionsHealth.closedTpFull}</div>
              <div><TrendingDown className="inline h-3 w-3 text-red-500" /> SL: {data.positionsHealth.closedSl}</div>
              <div>T20 hit: {data.positionsHealth.closedTrailing20Hit}</div>
              <div>T50 hit: {data.positionsHealth.closedTrailing50Hit}</div>
              <div>Struct break: {data.positionsHealth.closedStructureBreak}</div>
              <div>Avg PnL: {pct(data.positionsHealth.avgRealizedPnlPct)}</div>
              <div>Avg slippage: {pct(data.positionsHealth.avgSlippagePct)}</div>
              {data.positionsHealth.anomalousFillCount > 0 && (
                <div className="col-span-2 md:col-span-4 text-amber-600">
                  <AlertTriangle className="mr-1 inline h-3 w-3" />
                  {data.positionsHealth.anomalousFillCount} anomalous fills (slippage &gt; 1%) — review
                </div>
              )}
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">ETL health</h2>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div>Baselines: <span className="font-medium">{data.etlHealth.baselineCount}</span></div>
              <div>Legacy snapshot: <span className="font-medium">{data.etlHealth.legacySnapshotCount}</span></div>
              <div>
                Freshness:{' '}
                <span className={data.etlHealth.baselineFreshnessHours && data.etlHealth.baselineFreshnessHours > 26 ? 'text-amber-600' : ''}>
                  {data.etlHealth.baselineFreshnessHours === null ? '—' : `${data.etlHealth.baselineFreshnessHours}h`}
                </span>
              </div>
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">Recent candidates (50)</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="pb-2 text-left">TS</th>
                    <th className="pb-2 text-left">Symbol</th>
                    <th className="pb-2 text-left">Market</th>
                    <th className="pb-2 text-right">Score</th>
                    <th className="pb-2 text-left">Decision</th>
                    <th className="pb-2 text-left">Trigger</th>
                    <th className="pb-2 text-left">Reject reason</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentCandidates.map((c, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="py-1 font-mono">{c.ts.slice(11, 19)}</td>
                      <td className="py-1 font-medium">{c.symbol}</td>
                      <td className="py-1 text-muted-foreground">{c.market}</td>
                      <td className="py-1 text-right font-mono">{c.score?.toFixed(2) ?? '—'}</td>
                      <td className={`py-1 font-medium ${c.decision === 'ACCEPT' ? 'text-emerald-600' : 'text-red-600'}`}>
                        {c.decision}
                      </td>
                      <td className="py-1 font-mono">{c.trigger ?? '—'}</td>
                      <td className="py-1 font-mono">{c.rejectReason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="text-xs text-muted-foreground">
            <Activity className="mr-1 inline h-3 w-3" />
            asOf {new Date(data.asOf).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}
