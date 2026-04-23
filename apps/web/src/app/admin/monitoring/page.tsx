'use client';

import { useEffect, useState, useCallback } from 'react';
import { Activity, CheckCircle, XCircle, AlertTriangle, RefreshCw, Zap, Server, Bot } from 'lucide-react';
import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type Status = 'ok' | 'error' | 'loading' | 'unknown';

interface Check {
  label: string;
  status: Status;
  detail?: string;
  latencyMs?: number;
}

function StatusIcon({ status }: { status: Status }) {
  if (status === 'loading') return <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (status === 'ok') return <CheckCircle className="h-4 w-4 text-emerald-500" />;
  if (status === 'error') return <XCircle className="h-4 w-4 text-red-500" />;
  return <AlertTriangle className="h-4 w-4 text-amber-500" />;
}

function CheckRow({ check }: { check: Check }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b last:border-0">
      <div className="flex items-center gap-2.5">
        <StatusIcon status={check.status} />
        <span className="text-sm font-medium">{check.label}</span>
        {check.detail && (
          <span className="text-xs text-muted-foreground">{check.detail}</span>
        )}
      </div>
      {check.latencyMs !== undefined && (
        <span className={`text-xs tabular-nums ${check.latencyMs > 1000 ? 'text-amber-500' : 'text-muted-foreground'}`}>
          {check.latencyMs} ms
        </span>
      )}
    </div>
  );
}

export default function MonitoringPage() {
  const [checks, setChecks] = useState<Record<string, Check>>({
    api: { label: 'API Fly', status: 'loading' },
    supabase: { label: 'Supabase DB', status: 'loading' },
    claude: { label: 'Claude (ANTHROPIC_API_KEY)', status: 'unknown', detail: 'vérification indirecte' },
    eodhd: { label: 'EODHD prix live', status: 'unknown', detail: 'vérification via snapshot Lisa' },
    lisa_proposals: { label: 'Propositions Lisa (24h)', status: 'loading' },
    lisa_positions: { label: 'Positions simulées ouvertes', status: 'loading' },
    lisa_autopilot: { label: 'Portfolios en autopilot', status: 'loading' },
    kill_switch: { label: 'Kill-switch global', status: 'loading' },
  });
  const [usage, setUsage] = useState<{
    claudeToday: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; costEur: number };
    claudeMonth: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; costEur: number };
    claudeAll: { requests: number; costUsd: number; costEur: number };
    eodhdToday: { total: number; success: number; failures: number; fallbacks: number; avgLatencyMs: number };
    eodhdMonth: { calls: number; subscriptionUsd: number; subscriptionEur: number };
    eodhdAll: { total: number; success: number };
    eodhdLastCallAsOf: string | null;
    usdEurRate: number;
  }>({
    claudeToday: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costEur: 0 },
    claudeMonth: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costEur: 0 },
    claudeAll: { requests: 0, costUsd: 0, costEur: 0 },
    eodhdToday: { total: 0, success: 0, failures: 0, fallbacks: 0, avgLatencyMs: 0 },
    eodhdMonth: { calls: 0, subscriptionUsd: 19.99, subscriptionEur: 18.59 },
    eodhdAll: { total: 0, success: 0 },
    eodhdLastCallAsOf: null,
    usdEurRate: 0.93,
  });
  const [binance, setBinance] = useState<{
    configured: boolean;
    balances: Array<{ asset: string; free: string; locked: string; total: string; usdPrice: string; usdValue: string }>;
    totalUsd: string;
    lastSyncAt: string | null;
    error?: string;
    loading: boolean;
  }>({ configured: false, balances: [], totalUsd: '0.00', lastSyncAt: null, loading: true });
  const [quota, setQuota] = useState<{
    count24h: number;
    hardCap: number;
    warnThreshold: number;
    wsConnected: boolean;
    activeCryptoCount: number;
  }>({ count24h: 0, hardCap: 95000, warnThreshold: 80000, wsConnected: false, activeCryptoCount: 0 });
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const runChecks = useCallback(async () => {
    setRefreshing(true);

    // 1. API health
    const apiStart = Date.now();
    try {
      const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(5000) });
      const latencyMs = Date.now() - apiStart;
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      setChecks((c) => ({
        ...c,
        api: {
          label: 'API Fly',
          status: res.ok ? 'ok' : 'error',
          detail: res.ok ? String(body.status ?? 'up') : `HTTP ${res.status}`,
          latencyMs,
        },
      }));
    } catch {
      setChecks((c) => ({
        ...c,
        api: { label: 'API Fly', status: 'error', detail: 'timeout ou réseau', latencyMs: Date.now() - apiStart },
      }));
    }

    // 2. Supabase
    const supabase = createSupabaseBrowserClient();
    const sbStart = Date.now();
    try {
      const { error } = await supabase.from('portfolios').select('id').limit(1);
      const latencyMs = Date.now() - sbStart;
      setChecks((c) => ({
        ...c,
        supabase: {
          label: 'Supabase DB',
          status: error ? 'error' : 'ok',
          detail: error ? error.message : 'connecté',
          latencyMs,
        },
      }));
    } catch (e) {
      setChecks((c) => ({
        ...c,
        supabase: { label: 'Supabase DB', status: 'error', detail: String(e) },
      }));
    }

    // 3. Lisa stats (24h proposals)
    try {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const { count, error } = await supabase
        .from('lisa_proposals')
        .select('*', { count: 'exact', head: true })
        .gte('generated_at', since);
      setChecks((c) => ({
        ...c,
        lisa_proposals: {
          label: 'Propositions Lisa (24h)',
          status: error ? 'error' : 'ok',
          detail: error ? error.message : `${count ?? 0} propositions`,
        },
      }));
    } catch {
      setChecks((c) => ({ ...c, lisa_proposals: { label: 'Propositions Lisa (24h)', status: 'error' } }));
    }

    // 4. Lisa positions ouvertes
    try {
      const { count, error } = await supabase
        .from('lisa_positions')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'open');
      setChecks((c) => ({
        ...c,
        lisa_positions: {
          label: 'Positions simulées ouvertes',
          status: error ? 'error' : 'ok',
          detail: error ? error.message : `${count ?? 0} positions`,
        },
      }));
    } catch {
      setChecks((c) => ({ ...c, lisa_positions: { label: 'Positions simulées ouvertes', status: 'error' } }));
    }

    // 5. Autopilot actif
    try {
      const { count, error } = await supabase
        .from('lisa_session_configs')
        .select('*', { count: 'exact', head: true })
        .eq('autopilot_enabled', true)
        .eq('kill_switch_active', false);
      setChecks((c) => ({
        ...c,
        lisa_autopilot: {
          label: 'Portfolios en autopilot',
          status: error ? 'error' : 'ok',
          detail: error ? error.message : `${count ?? 0} actif(s)`,
        },
      }));
    } catch {
      setChecks((c) => ({ ...c, lisa_autopilot: { label: 'Portfolios en autopilot', status: 'error' } }));
    }

    // 6. Feature flags (kill-switch)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch(`${API}/feature-flags`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const flags = await res.json() as Record<string, boolean>;
        const ksActive = flags['AUTONOMY_KILL_SWITCH'] === true;
        setChecks((c) => ({
          ...c,
          kill_switch: {
            label: 'Kill-switch global',
            status: ksActive ? 'error' : 'ok',
            detail: ksActive ? 'ACTIF — toute autonomie suspendue' : 'inactif (normal)',
          },
        }));
      }
    } catch {
      setChecks((c) => ({ ...c, kill_switch: { label: 'Kill-switch global', status: 'unknown' } }));
    }

    // 7. Claude + EODHD — dernière proposition générée
    try {
      const { data } = await supabase
        .from('lisa_proposals')
        .select('generated_at, claude_model, claude_input_tokens')
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data) {
        const ago = Math.round((Date.now() - new Date(data.generated_at as string).getTime()) / 60_000);
        setChecks((c) => ({
          ...c,
          claude: {
            label: 'Claude (ANTHROPIC_API_KEY)',
            status: 'ok',
            detail: `${String(data.claude_model ?? '?')} · ${ago}min · ${String(data.claude_input_tokens ?? 0)} tokens`,
          },
          eodhd: {
            label: 'EODHD prix live',
            status: 'ok',
            detail: `dernier appel il y a ${ago}min`,
          },
        }));
      } else {
        setChecks((c) => ({
          ...c,
          claude: { label: 'Claude (ANTHROPIC_API_KEY)', status: 'unknown', detail: 'aucune proposition générée encore' },
          eodhd: { label: 'EODHD prix live', status: 'unknown', detail: 'aucune proposition générée encore' },
        }));
      }
    } catch {
      // keep unknown
    }

    // 8. Claude + EODHD stats via API backend (bypass RLS, fenêtres calendaires UTC)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const authHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

      const [claudeRes, eodhdRes] = await Promise.all([
        fetch(`${API}/lisa/claude/stats`, { headers: authHeaders, signal: AbortSignal.timeout(5000) }),
        fetch(`${API}/lisa/eodhd/stats`, { headers: authHeaders, signal: AbortSignal.timeout(5000) }),
      ]);

      const next = { ...usage };
      if (claudeRes.ok) {
        const c = await claudeRes.json() as {
          today: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; costEur: number };
          thisMonth: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; costEur: number };
          all: { requests: number; costUsd: number; costEur: number };
          usdEurRate: number;
        };
        next.claudeToday = c.today;
        next.claudeMonth = c.thisMonth;
        next.claudeAll = c.all;
        next.usdEurRate = c.usdEurRate;
      }
      if (eodhdRes.ok) {
        const e = await eodhdRes.json() as {
          today: { total: number; success: number; failures: number; fallbacks: number; avgLatencyMs: number };
          thisMonth: { calls: number; subscriptionUsd: number; subscriptionEur: number };
          all: { total: number; success: number };
          lastCallAsOf: string | null;
          usdEurRate: number;
        };
        next.eodhdToday = e.today;
        next.eodhdMonth = e.thisMonth;
        next.eodhdAll = e.all;
        next.eodhdLastCallAsOf = e.lastCallAsOf;
        next.usdEurRate = e.usdEurRate;
      }
      setUsage(next);
    } catch {
      // keep defaults
    }

    // 10. Balance Binance (compte externe)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const bRes = await fetch(`${API}/lisa/binance/balance`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (bRes.ok) {
        const body = await bRes.json() as {
          configured: boolean;
          balances: Array<{ asset: string; free: string; locked: string; total: string; usdPrice: string; usdValue: string }>;
          totalUsd: string;
          lastSyncAt: string | null;
          error?: string;
        };
        setBinance({ ...body, loading: false });
      } else {
        setBinance({ configured: false, balances: [], totalUsd: '0.00', lastSyncAt: null, error: `HTTP ${bRes.status}`, loading: false });
      }
    } catch (e) {
      setBinance({ configured: false, balances: [], totalUsd: '0.00', lastSyncAt: null, error: String(e).slice(0, 120), loading: false });
    }

    // 11. Quota EODHD + état WebSocket Binance (depuis /lisa/realtime/price-cache)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const qRes = await fetch(`${API}/lisa/realtime/price-cache`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (qRes.ok) {
        const body = await qRes.json() as {
          wsConnected: boolean;
          activeCryptoCount: number;
          quota: { count24h: number; hardCap: number; warnThreshold: number; lastCheckAsOf: string | null };
        };
        setQuota({
          count24h: body.quota.count24h,
          hardCap: body.quota.hardCap,
          warnThreshold: body.quota.warnThreshold,
          wsConnected: body.wsConnected,
          activeCryptoCount: body.activeCryptoCount,
        });
      }
    } catch { /* keep defaults */ }

    setLastRefresh(new Date());
    setRefreshing(false);
  }, []);

  useEffect(() => { void runChecks(); }, [runChecks]);

  const allOk = Object.values(checks).every((c) => c.status === 'ok' || c.status === 'unknown');
  const hasError = Object.values(checks).some((c) => c.status === 'error');

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Activity className="h-5 w-5 text-primary" />
            Monitoring SmartVest
          </h1>
          <p className="text-sm text-muted-foreground">
            État en temps réel de l'infrastructure
          </p>
        </div>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => void runChecks()} disabled={refreshing}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Rafraîchir
        </Button>
      </div>

      {/* Global status banner */}
      <div className={`rounded-lg border p-4 ${hasError ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30' : allOk ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30' : 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30'}`}>
        <p className={`text-sm font-medium ${hasError ? 'text-red-700 dark:text-red-300' : allOk ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
          {hasError ? 'Problème détecté — voir détails ci-dessous' : allOk ? 'Tous les systèmes opérationnels' : 'Vérification en cours…'}
        </p>
        {lastRefresh && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Dernière vérification : {lastRefresh.toLocaleTimeString('fr-FR')}
          </p>
        )}
      </div>

      {/* Infrastructure */}
      <div className="rounded-lg border">
        <div className="flex items-center gap-2 border-b px-4 py-2.5 bg-muted/30">
          <Server className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Infrastructure</span>
        </div>
        <div className="px-4">
          <CheckRow check={checks.api} />
          <CheckRow check={checks.supabase} />
          <CheckRow check={checks.kill_switch} />
        </div>
      </div>

      {/* Lisa */}
      <div className="rounded-lg border">
        <div className="flex items-center gap-2 border-b px-4 py-2.5 bg-muted/30">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lisa — AI Analyst</span>
        </div>
        <div className="px-4">
          <CheckRow check={checks.lisa_proposals} />
          <CheckRow check={checks.lisa_positions} />
          <CheckRow check={checks.lisa_autopilot} />
        </div>
      </div>

      {/* Providers externes */}
      <div className="rounded-lg border">
        <div className="flex items-center gap-2 border-b px-4 py-2.5 bg-muted/30">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Providers externes</span>
        </div>
        <div className="px-4">
          <CheckRow check={checks.claude} />
          <CheckRow check={checks.eodhd} />
        </div>
      </div>

      {/* Quotas & usage */}
      <div className="rounded-lg border">
        <div className="flex items-center gap-2 border-b px-4 py-2.5 bg-muted/30">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quotas & usage</span>
        </div>
        <div className="divide-y">
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Claude API</span>
              <span className="text-[10px] font-mono text-muted-foreground">sonnet/opus via Anthropic</span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs">
              <div className="rounded-md bg-muted/30 p-2">
                <p className="text-[10px] text-muted-foreground">Requêtes (aujourd'hui)</p>
                <p className="font-mono font-medium tabular-nums">{usage.claudeToday.requests}</p>
                <p className="text-[10px] text-muted-foreground">mois : {usage.claudeMonth.requests}</p>
              </div>
              <div className="rounded-md bg-muted/30 p-2">
                <p className="text-[10px] text-muted-foreground">Input tokens (aujourd'hui)</p>
                <p className="font-mono font-medium tabular-nums">{usage.claudeToday.inputTokens.toLocaleString('fr-FR')}</p>
                <p className="text-[10px] text-muted-foreground">mois : {usage.claudeMonth.inputTokens.toLocaleString('fr-FR')}</p>
              </div>
              <div className="rounded-md bg-muted/30 p-2">
                <p className="text-[10px] text-muted-foreground">Output tokens (aujourd'hui)</p>
                <p className="font-mono font-medium tabular-nums">{usage.claudeToday.outputTokens.toLocaleString('fr-FR')}</p>
                <p className="text-[10px] text-muted-foreground">mois : {usage.claudeMonth.outputTokens.toLocaleString('fr-FR')}</p>
              </div>
              <div className="rounded-md bg-muted/30 p-2">
                <p className="text-[10px] text-muted-foreground">Coût (aujourd'hui)</p>
                <p className="font-mono font-medium tabular-nums">€{usage.claudeToday.costEur.toFixed(4)}</p>
                <p className="text-[10px] text-muted-foreground">mois : €{usage.claudeMonth.costEur.toFixed(2)}</p>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground italic">
              Fenêtres calendaires UTC : "aujourd'hui" = depuis 00:00 UTC, "mois" = depuis le 1er à 00:00 UTC.
              Conversion USD→EUR au taux {usage.usdEurRate.toFixed(3)} (configurable via env USD_EUR_RATE).
            </p>
          </div>
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-sm font-medium">EODHD (prix live)</span>
              <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
                {usage.eodhdLastCallAsOf && (() => {
                  const ageMs = Date.now() - new Date(usage.eodhdLastCallAsOf).getTime();
                  let human: string;
                  if (ageMs < 60_000) human = `${Math.round(ageMs / 1000)}s`;
                  else if (ageMs < 3_600_000) human = `${Math.round(ageMs / 60_000)}min`;
                  else if (ageMs < 86_400_000) human = `${Math.round(ageMs / 3_600_000)}h`;
                  else human = `${Math.round(ageMs / 86_400_000)}j`;
                  // Rouge si > 2min (cron devrait tourner toutes les 30s)
                  const isStale = ageMs > 120_000;
                  return (
                    <span className={isStale ? 'text-amber-600' : ''}>
                      dernier appel : il y a {human}
                    </span>
                  );
                })()}
                <span>
                  {usage.eodhdToday.total > 0
                    ? `${Math.round((usage.eodhdToday.success / usage.eodhdToday.total) * 100)}% success`
                    : 'aucun appel aujourd\'hui'}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs">
              <div className="rounded-md bg-muted/30 p-2">
                <p className="text-[10px] text-muted-foreground">Appels (aujourd'hui)</p>
                <p className="font-mono font-medium tabular-nums">{usage.eodhdToday.total}</p>
                <p className="text-[10px] text-muted-foreground">mois : {usage.eodhdMonth.calls.toLocaleString('fr-FR')}</p>
              </div>
              <div className="rounded-md bg-muted/30 p-2">
                <p className="text-[10px] text-muted-foreground">Succès (aujourd'hui)</p>
                <p className="font-mono font-medium tabular-nums text-emerald-600">{usage.eodhdToday.success}</p>
                <p className="text-[10px] text-muted-foreground">total : {usage.eodhdAll.success.toLocaleString('fr-FR')}</p>
              </div>
              <div className="rounded-md bg-muted/30 p-2">
                <p className="text-[10px] text-muted-foreground">Échecs (aujourd'hui)</p>
                <p className={`font-mono font-medium tabular-nums ${usage.eodhdToday.failures > 0 ? 'text-red-500' : ''}`}>
                  {usage.eodhdToday.failures}
                </p>
                <p className="text-[10px] text-muted-foreground">fallback : {usage.eodhdToday.fallbacks}</p>
              </div>
              <div className="rounded-md bg-muted/30 p-2">
                <p className="text-[10px] text-muted-foreground">Latence moy.</p>
                <p className={`font-mono font-medium tabular-nums ${usage.eodhdToday.avgLatencyMs > 1000 ? 'text-amber-500' : ''}`}>
                  {usage.eodhdToday.avgLatencyMs} ms
                </p>
                <p className="text-[10px] text-muted-foreground">cap : 95 k/j ↓</p>
              </div>
            </div>

            {/* Jauge quota journalier — hard cap 95k, warn 80k */}
            {(() => {
              const pct = Math.min(100, (quota.count24h / quota.hardCap) * 100);
              const warnPct = (quota.warnThreshold / quota.hardCap) * 100;
              let fillColor = 'bg-emerald-500';
              let label = 'OK';
              if (quota.count24h >= quota.hardCap) { fillColor = 'bg-red-500'; label = 'CAP ATTEINT — appels EODHD bloqués'; }
              else if (quota.count24h >= quota.warnThreshold) { fillColor = 'bg-amber-500'; label = 'Proche du cap — ralentissement préventif'; }
              return (
                <div className="rounded-md border p-2 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-medium">Quota journalier EODHD (reset 00:00 UTC)</span>
                    <span className="font-mono tabular-nums">
                      {quota.count24h.toLocaleString('fr-FR')} / {quota.hardCap.toLocaleString('fr-FR')}
                      <span className="text-muted-foreground"> ({pct.toFixed(1)}%)</span>
                    </span>
                  </div>
                  <div className="relative h-2 rounded-full bg-muted overflow-hidden">
                    <div className={`h-full ${fillColor} transition-all`} style={{ width: `${pct}%` }} />
                    {/* Marqueur du seuil d'avertissement */}
                    <div
                      className="absolute top-0 h-full w-[1px] bg-amber-600/70"
                      style={{ left: `${warnPct}%` }}
                      title={`Seuil warn : ${quota.warnThreshold.toLocaleString('fr-FR')}`}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>{label}</span>
                    <span>Hard cap = 95 k/j (marge 5 k vs quota 100 k)</span>
                  </div>
                </div>
              );
            })()}

            {/* WebSocket Binance status */}
            <div className="rounded-md border p-2 flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${quota.wsConnected ? 'bg-emerald-500' : 'bg-red-500'}`} />
                <span className="font-medium">Binance WebSocket</span>
                <span className="text-muted-foreground">
                  {quota.wsConnected ? 'connecté' : 'déconnecté'} · {quota.activeCryptoCount} crypto(s) suivie(s)
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground">prix crypto temps réel gratuits</span>
            </div>

            <p className="text-[10px] text-muted-foreground italic">
              Compteur précis depuis la table <code className="rounded bg-muted px-1">eodhd_request_log</code> (1 ligne par appel).
              Les fallbacks (cache Supabase ou prix statique) ne consomment pas le quota EODHD.
            </p>
          </div>
        </div>
      </div>

      {/* Synthèse coût mensuel calendaire (EUR) */}
      <div className="rounded-lg border">
        <div className="flex items-center gap-2 border-b px-4 py-2.5 bg-muted/30">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Coût mensuel infrastructure (EUR)</span>
          <span className="ml-auto text-[10px] font-mono text-muted-foreground">
            mois calendaire · taux USD→EUR {usage.usdEurRate.toFixed(3)}
          </span>
        </div>
        <div className="divide-y">
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-4 py-2.5 text-xs items-center">
            <span className="font-medium">Claude API (consommation tokens)</span>
            <span className="font-mono tabular-nums text-muted-foreground">${usage.claudeMonth.costUsd.toFixed(2)}</span>
            <span className="font-mono font-medium tabular-nums w-20 text-right">€{usage.claudeMonth.costEur.toFixed(2)}</span>
          </div>
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-4 py-2.5 text-xs items-center">
            <div>
              <span className="font-medium">EODHD (abonnement mensuel fixe)</span>
              <span className="block text-[10px] text-muted-foreground">
                {usage.eodhdMonth.calls.toLocaleString('fr-FR')} appels ce mois · plan 100 k/jour
              </span>
            </div>
            <span className="font-mono tabular-nums text-muted-foreground">${usage.eodhdMonth.subscriptionUsd.toFixed(2)}</span>
            <span className="font-mono font-medium tabular-nums w-20 text-right">€{usage.eodhdMonth.subscriptionEur.toFixed(2)}</span>
          </div>
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-4 py-3 text-sm items-center bg-muted/20">
            <span className="font-semibold">Total mensuel</span>
            <span className="font-mono tabular-nums text-muted-foreground">
              ${(usage.claudeMonth.costUsd + usage.eodhdMonth.subscriptionUsd).toFixed(2)}
            </span>
            <span className="font-mono font-bold tabular-nums w-20 text-right">
              €{(usage.claudeMonth.costEur + usage.eodhdMonth.subscriptionEur).toFixed(2)}
            </span>
          </div>
        </div>
        <p className="px-4 pb-3 pt-1 text-[10px] text-muted-foreground italic">
          Fly.io (machine 24/7) ~€1.80/mois non inclus ici — facturé séparément par Fly.
          Abonnement EODHD réglable via env var <code className="rounded bg-muted px-1">EODHD_MONTHLY_COST_USD</code>,
          taux de change via <code className="rounded bg-muted px-1">USD_EUR_RATE</code>.
        </p>
      </div>

      {/* Balance Binance — compte externe utilisateur, lecture seule */}
      <div className="rounded-lg border">
        <div className="flex items-center gap-2 border-b px-4 py-2.5 bg-muted/30">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Binance — compte externe (lecture seule)</span>
          {binance.configured && binance.balances.length > 0 && (
            <span className="ml-auto text-xs font-mono tabular-nums">
              Total : <span className="font-medium">${parseFloat(binance.totalUsd).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </span>
          )}
        </div>
        <div className="px-4 py-3">
          {binance.loading && (
            <p className="text-xs text-muted-foreground">Chargement du solde…</p>
          )}
          {!binance.loading && !binance.configured && (
            <p className="text-xs text-muted-foreground">
              Clés Binance non configurées. Ajoute <code className="rounded bg-muted px-1">BINANCE_API_KEY</code> et <code className="rounded bg-muted px-1">BINANCE_SECRET_KEY</code> dans les secrets Fly.
            </p>
          )}
          {!binance.loading && binance.configured && binance.error && (
            <p className="text-xs text-red-500">
              Erreur Binance : <code className="rounded bg-muted px-1">{binance.error}</code>
            </p>
          )}
          {!binance.loading && binance.configured && !binance.error && binance.balances.length === 0 && (
            <p className="text-xs text-muted-foreground">Compte Binance vide (aucun asset avec solde &gt; 0).</p>
          )}
          {!binance.loading && binance.balances.length > 0 && (
            <div className="divide-y">
              {binance.balances.map((b) => (
                <div key={b.asset} className="grid grid-cols-5 gap-2 py-2 text-xs items-center">
                  <span className="font-medium font-mono">{b.asset}</span>
                  <span className="text-right font-mono tabular-nums text-muted-foreground">
                    {parseFloat(b.total).toLocaleString('fr-FR', { maximumFractionDigits: 8 })}
                  </span>
                  <span className="text-right font-mono tabular-nums text-muted-foreground">
                    ${parseFloat(b.usdPrice).toLocaleString('fr-FR', { maximumFractionDigits: 4 })}
                  </span>
                  <span className="col-span-2 text-right font-mono tabular-nums font-medium">
                    ${parseFloat(b.usdValue).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              ))}
              {binance.lastSyncAt && (
                <p className="pt-2 text-[10px] text-muted-foreground italic">
                  Dernière sync Binance : {new Date(binance.lastSyncAt).toLocaleString('fr-FR')}.
                  Lecture seule — SmartVest ne peut ni trader ni retirer.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Claude et EODHD sont vérifiés indirectement via la dernière proposition Lisa générée.
        <br />
        Pour une alerte email en cas de panne, configure un ping externe sur{' '}
        <code className="rounded bg-muted px-1">{API}/health</code>
      </p>
    </div>
  );
}
