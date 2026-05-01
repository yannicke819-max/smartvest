'use client';

import { useState } from 'react';
import Link from 'next/link';
import { FlaskConical, Upload, Plus, Trash2, FileText, ArrowLeft, BarChart3, RefreshCw, TrendingUp } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts';
import {
  useBots,
  useBotTrades,
  useCreateBot,
  useDeleteBot,
  useImportCsv,
  useBotMetrics,
  useBotEquityCurve,
  useBotSessionMetrics,
  useRecomputeBot,
  useTriggerAutoSync,
  type BotDefinition,
  type BotSourceType,
  type BotPerformanceSummary,
  type EquityCurvePoint,
  type SessionMetrics,
} from '@/hooks/use-bot-lab';
import { Zap } from 'lucide-react';

type DetailTab = 'overview' | 'metrics' | 'equity' | 'sessions' | 'trades';

export default function BotLabPage() {
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);

  return (
    <div className="container mx-auto p-4 space-y-6 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link
            href="/"
            className="text-xs text-muted-foreground hover:underline flex items-center gap-1 mb-2"
          >
            <ArrowLeft className="h-3 w-3" />
            Retour
          </Link>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FlaskConical className="h-6 w-6 text-blue-600" />
            Mes stratégies auto <span className="text-sm font-normal text-muted-foreground">(mode démo)</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Importe des bots externes (CSV ou stratégies), mesure leurs performances avec
            des indicateurs standardisés (Sharpe, Sortino, drawdown maximum, profit factor)
            et identifie les patterns robustes à transférer à Lisa. 100 % simulation, aucun argent réel engagé.
          </p>
        </div>
        <Link
          href={{ pathname: '/bot-lab/patterns' }}
          className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted flex items-center gap-1.5 self-start"
        >
          <BarChart3 className="h-3 w-3" />
          Pattern Miner →
        </Link>
      </div>

      {selectedBotId ? (
        <BotDetailView botId={selectedBotId} onBack={() => setSelectedBotId(null)} />
      ) : (
        <BotListView onSelectBot={setSelectedBotId} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LIST VIEW
// ═══════════════════════════════════════════════════════════════════

function BotListView({ onSelectBot }: { onSelectBot: (botId: string) => void }) {
  const botsQuery = useBots();
  const deleteMut = useDeleteBot();
  const autoSyncMut = useTriggerAutoSync();
  const [showCreateForm, setShowCreateForm] = useState(false);

  const handleAutoSync = async () => {
    try {
      const r = await autoSyncMut.mutateAsync();
      alert(`Sync terminé : ${r.totalImported} nouveaux trades importés sur ${r.syncedPortfolios} portfolio(s)`);
    } catch (e) {
      alert(`Erreur sync: ${String(e).slice(0, 200)}`);
    }
  };

  return (
    <div className="space-y-4">
      {/* Auto-sync banner — alternative au CSV */}
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20 p-4 space-y-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-medium flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
              <Zap className="h-4 w-4" />
              Auto-sync Lisa Live
            </h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
              Les trades fermés de Lisa sont automatiquement synchronisés vers un bot dédié <strong>« Lisa Live »</strong> par
              portfolio simulation, toutes les 30 min via cron. Pas de CSV nécessaire — tu peux directement
              extraire des patterns de TES propres trades. Boucle vertueuse : Lisa trade → patterns extraits → Lisa adopte → Lisa s&apos;améliore.
            </p>
          </div>
          <button
            onClick={handleAutoSync}
            disabled={autoSyncMut.isPending}
            className="rounded-md bg-emerald-600 text-white px-3 py-1.5 text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5 self-start"
          >
            <Zap className={`h-3 w-3 ${autoSyncMut.isPending ? 'animate-pulse' : ''}`} />
            {autoSyncMut.isPending ? 'Sync…' : 'Sync maintenant'}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Mes bots ({botsQuery.data?.bots.length ?? 0})</h2>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 flex items-center gap-1"
        >
          <Plus className="h-3 w-3" />
          Nouveau bot manuel
        </button>
      </div>

      {showCreateForm && (
        <CreateBotForm onCancel={() => setShowCreateForm(false)} onCreated={() => setShowCreateForm(false)} />
      )}

      {botsQuery.isLoading && (
        <div className="text-sm text-muted-foreground">Chargement…</div>
      )}

      {botsQuery.data?.bots.length === 0 && !showCreateForm && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Aucun bot encore. Crée-en un et importe des trades CSV.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {botsQuery.data?.bots.map((bot) => (
          <BotCard
            key={bot.id}
            bot={bot}
            onClick={() => onSelectBot(bot.id)}
            onDelete={() => {
              if (confirm(`Supprimer le bot ${bot.name} et tous ses trades ?`)) {
                deleteMut.mutate(bot.id);
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}

function BotCard({ bot, onClick, onDelete }: { bot: BotDefinition; onClick: () => void; onDelete: () => void }) {
  const pnl = parseFloat(bot.totalRealizedPnlUsd);
  const pnlSign = pnl >= 0 ? '+' : '';
  const sourceColor = {
    csv_import: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40',
    api_external: 'bg-purple-100 text-purple-700 dark:bg-purple-950/40',
    lisa_replay: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40',
    manual: 'bg-slate-100 text-slate-700 dark:bg-slate-900/40',
  }[bot.sourceType];

  return (
    <div className="rounded-lg border p-4 space-y-3 hover:bg-muted/30 transition-colors cursor-pointer relative" onClick={onClick}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-sm truncate">{bot.name}</h3>
          {bot.description && (
            <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{bot.description}</p>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-muted-foreground hover:text-red-600 p-1"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      <div className="flex items-center gap-2 text-[10px] flex-wrap">
        <span className={`rounded px-1.5 py-0.5 font-mono uppercase ${sourceColor}`}>
          {bot.sourceType}
        </span>
        {bot.tags.map((t) => (
          <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
            {t}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 pt-2 border-t text-xs">
        <div>
          <div className="text-[10px] uppercase text-muted-foreground">Trades</div>
          <div className="font-mono font-medium">{bot.totalTrades}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-muted-foreground">PnL réalisé</div>
          <div className={`font-mono font-medium ${pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {pnlSign}${Math.abs(pnl).toFixed(2)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CREATE FORM
// ═══════════════════════════════════════════════════════════════════

function CreateBotForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const createMut = useCreateBot();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sourceType, setSourceType] = useState<BotSourceType>('csv_import');
  const [capitalBaseUsd, setCapitalBaseUsd] = useState(10000);
  const [tags, setTags] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await createMut.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        sourceType,
        capitalBaseUsd,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      onCreated();
    } catch (e) {
      console.error('Create failed:', e);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border p-4 space-y-3 bg-muted/20">
      <h3 className="text-sm font-medium">Nouveau bot</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-muted-foreground mb-1 block">Nom *</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Momentum SPY 2024"
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground mb-1 block">Type de source</span>
          <select
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value as BotSourceType)}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          >
            <option value="csv_import">CSV import</option>
            <option value="manual">Manuel (saisie progressive)</option>
            <option value="lisa_replay">Lisa replay (ses trades fermés)</option>
            <option value="api_external" disabled>API externe (Phase 2)</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground mb-1 block">Capital de base (USD)</span>
          <input
            type="number"
            min="100"
            step="100"
            value={capitalBaseUsd}
            onChange={(e) => setCapitalBaseUsd(parseFloat(e.target.value) || 10000)}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground mb-1 block">Tags (virgule)</span>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="momentum, equity, swing"
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          />
        </label>
      </div>
      <label className="block">
        <span className="text-xs text-muted-foreground mb-1 block">Description (optionnel)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Stratégie momentum simple sur SPY 50/200 MA cross"
          className="w-full rounded-md border bg-background p-2 text-xs"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={createMut.isPending || !name.trim()}
          className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {createMut.isPending ? 'Création…' : 'Créer'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border px-4 py-1.5 text-xs font-medium hover:bg-muted"
        >
          Annuler
        </button>
      </div>
    </form>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DETAIL VIEW
// ═══════════════════════════════════════════════════════════════════

function BotDetailView({ botId, onBack }: { botId: string; onBack: () => void }) {
  const tradesQuery = useBotTrades(botId, 100);
  const importMut = useImportCsv(botId);
  const recomputeMut = useRecomputeBot(botId);
  const [csvText, setCsvText] = useState('');
  const [tab, setTab] = useState<DetailTab>('overview');

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
  };

  const handleImport = async () => {
    if (!csvText.trim()) return;
    try {
      const result = await importMut.mutateAsync(csvText);
      alert(`Import terminé : ${result.inserted} insérés, ${result.skipped} skip (déjà importés), ${result.errors} erreurs sur ${result.totalParsed} parsés`);
      setCsvText('');
      // Auto-recompute après import
      if (result.inserted > 0) {
        await recomputeMut.mutateAsync().catch(() => null);
      }
    } catch (e) {
      alert(`Erreur import: ${String(e).slice(0, 200)}`);
    }
  };

  const handleRecompute = async () => {
    try {
      const r = await recomputeMut.mutateAsync();
      alert(`Recompute OK — ${r.tagged} tagged, ${r.daysGenerated} jours equity, finalEquity=$${r.finalEquity.toFixed(2)}`);
    } catch (e) {
      alert(`Erreur recompute: ${String(e).slice(0, 200)}`);
    }
  };

  const tabs: Array<{ id: DetailTab; label: string; icon: typeof FileText }> = [
    { id: 'overview', label: 'Vue d\'ensemble', icon: FlaskConical },
    { id: 'metrics', label: 'Métriques', icon: BarChart3 },
    { id: 'equity', label: 'Equity curve', icon: TrendingUp },
    { id: 'sessions', label: 'Par contexte', icon: BarChart3 },
    { id: 'trades', label: 'Trades', icon: FileText },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="text-xs text-muted-foreground hover:underline flex items-center gap-1"
        >
          <ArrowLeft className="h-3 w-3" />
          Retour à la liste
        </button>
        <button
          onClick={handleRecompute}
          disabled={recomputeMut.isPending}
          className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50 flex items-center gap-1"
        >
          <RefreshCw className={`h-3 w-3 ${recomputeMut.isPending ? 'animate-spin' : ''}`} />
          {recomputeMut.isPending ? 'Calcul…' : 'Recalculer métriques'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b overflow-x-auto">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                tab === t.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-3 w-3" />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'overview' && (
        <>
          {/* Import CSV */}
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Upload className="h-4 w-4 text-muted-foreground" />
              Importer des trades CSV
            </h3>
            <p className="text-xs text-muted-foreground">
              Format : <code className="font-mono">symbol,direction,entry_timestamp,entry_price,quantity,exit_timestamp,exit_price</code>
              <br />
              Optionnels : <code>asset_class</code>, <code>exit_reason</code>, <code>vix_at_entry</code>, <code>regime</code>, <code>entry_notional_usd</code>, <code>net_pnl_usd</code>, <code>external_id</code>.
              Idempotent par <code>external_id</code>.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                className="text-xs"
              />
              {csvText && (
                <span className="text-xs text-muted-foreground">
                  {csvText.split('\n').length - 1} lignes parsées
                </span>
              )}
            </div>
            {csvText && (
              <button
                onClick={handleImport}
                disabled={importMut.isPending}
                className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {importMut.isPending ? 'Import…' : 'Importer + recalculer métriques'}
              </button>
            )}
          </div>
        </>
      )}

      {tab === 'metrics' && <MetricsTab botId={botId} />}
      {tab === 'equity' && <EquityCurveTab botId={botId} />}
      {tab === 'sessions' && <SessionsTab botId={botId} />}

      {tab === 'trades' && (
      /* Trades list */
      <div className="rounded-lg border p-4 space-y-3">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Trades ({tradesQuery.data?.trades.length ?? 0})
        </h3>
        {tradesQuery.isLoading && (
          <div className="text-xs text-muted-foreground">Chargement…</div>
        )}
        {tradesQuery.data?.trades.length === 0 && (
          <div className="text-xs text-muted-foreground italic">
            Aucun trade encore. Importe un CSV ci-dessus.
          </div>
        )}
        {(tradesQuery.data?.trades.length ?? 0) > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-1.5 px-2">Symbole</th>
                  <th className="text-left py-1.5 px-2">Direction</th>
                  <th className="text-left py-1.5 px-2">Entry</th>
                  <th className="text-left py-1.5 px-2">Exit</th>
                  <th className="text-right py-1.5 px-2">PnL</th>
                  <th className="text-right py-1.5 px-2">PnL %</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {tradesQuery.data?.trades.map((t) => {
                  const pnl = t.netPnlUsd ? parseFloat(t.netPnlUsd) : 0;
                  const isOpen = !t.exitTimestamp;
                  return (
                    <tr key={t.id} className="border-b">
                      <td className="py-1.5 px-2 font-medium">{t.symbol}</td>
                      <td className="py-1.5 px-2 uppercase text-[10px]">{t.direction}</td>
                      <td className="py-1.5 px-2">
                        {parseFloat(t.entryPrice).toFixed(2)}
                        <span className="text-muted-foreground ml-1 text-[10px]">
                          {new Date(t.entryTimestamp).toLocaleDateString('fr-FR')}
                        </span>
                      </td>
                      <td className="py-1.5 px-2">
                        {isOpen ? (
                          <span className="text-amber-600">ouverte</span>
                        ) : (
                          <>
                            {t.exitPrice ? parseFloat(t.exitPrice).toFixed(2) : '—'}
                            <span className="text-muted-foreground ml-1 text-[10px]">
                              {t.exitTimestamp ? new Date(t.exitTimestamp).toLocaleDateString('fr-FR') : ''}
                            </span>
                          </>
                        )}
                      </td>
                      <td className={`text-right py-1.5 px-2 ${pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {isOpen ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`}
                      </td>
                      <td className={`text-right py-1.5 px-2 ${(t.netPnlPct ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {isOpen ? '—' : `${(t.netPnlPct ?? 0) >= 0 ? '+' : ''}${(t.netPnlPct ?? 0).toFixed(2)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// METRICS TAB
// ═══════════════════════════════════════════════════════════════════

function MetricsTab({ botId }: { botId: string }) {
  const metricsQuery = useBotMetrics(botId);

  if (metricsQuery.isLoading) return <div className="text-sm text-muted-foreground">Chargement…</div>;
  if (!metricsQuery.data?.summary) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Pas assez de trades fermés pour calculer les métriques (min 30 requis).
        <br />
        Importe un CSV avec plus de trades, ou clique sur &quot;Recalculer métriques&quot;.
      </div>
    );
  }

  const m = metricsQuery.data.summary;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <BigMetric
          label="Net PnL"
          value={`${m.netPnlUsd >= 0 ? '+' : ''}$${m.netPnlUsd.toFixed(2)}`}
          color={m.netPnlUsd >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600'}
          sublabel={`${m.netReturnPct >= 0 ? '+' : ''}${m.netReturnPct.toFixed(2)}% return${m.cagr != null ? ` · CAGR ${m.cagr.toFixed(1)}%` : ''}`}
        />
        <BigMetric
          label="Sharpe Ratio"
          value={m.sharpeRatio != null ? m.sharpeRatio.toFixed(2) : 'n/a'}
          color={m.sharpeRatio != null && m.sharpeRatio > 1 ? 'text-emerald-700 dark:text-emerald-300' : 'text-foreground'}
          sublabel={m.sharpeRatio != null ? (m.sharpeRatio > 1 ? 'edge confirmé' : 'à valider') : 'sample faible'}
        />
        <BigMetric
          label="Max Drawdown"
          value={`-${m.maxDrawdownPct.toFixed(2)}%`}
          color={m.maxDrawdownPct < 10 ? 'text-emerald-700 dark:text-emerald-300' : m.maxDrawdownPct < 20 ? 'text-amber-600' : 'text-red-600'}
          sublabel={m.recoveryDays != null ? `recovery ${m.recoveryDays}j` : 'pas récupéré'}
        />
        <BigMetric
          label="Win Rate"
          value={`${m.winRatePct.toFixed(1)}%`}
          color={m.winRatePct >= 55 ? 'text-emerald-700 dark:text-emerald-300' : m.winRatePct >= 45 ? 'text-amber-600' : 'text-red-600'}
          sublabel={`${m.totalTrades} trades / ${m.totalDays}j`}
        />
      </div>

      <div className="rounded-lg border p-4 space-y-3">
        <h3 className="text-sm font-medium">Métriques détaillées</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
          <Metric label="Sortino Ratio" value={m.sortinoRatio != null ? m.sortinoRatio.toFixed(2) : 'n/a'} />
          <Metric label="Profit Factor" value={m.profitFactor != null ? m.profitFactor.toFixed(2) : 'n/a'} />
          <Metric label="Expectancy / trade" value={`${m.expectancyPerTradeUsd >= 0 ? '+' : ''}$${m.expectancyPerTradeUsd.toFixed(2)}`} />
          <Metric label="Avg Win" value={`+$${m.avgWinUsd.toFixed(2)}`} />
          <Metric label="Avg Loss" value={`$${m.avgLossUsd.toFixed(2)}`} />
          <Metric label="Largest Win" value={`+$${m.largestWinUsd.toFixed(2)}`} />
          <Metric label="Largest Loss" value={`$${m.largestLossUsd.toFixed(2)}`} />
          <Metric label="Streak gains max" value={String(m.consecutiveWinsMax)} />
          <Metric label="Streak pertes max" value={String(m.consecutiveLossesMax)} />
        </div>
      </div>
    </div>
  );
}

function BigMetric(props: { label: string; value: string; color: string; sublabel?: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{props.label}</div>
      <div className={`text-xl font-mono font-bold tabular-nums mt-1 ${props.color}`}>{props.value}</div>
      {props.sublabel && (
        <div className="text-[10px] text-muted-foreground mt-0.5">{props.sublabel}</div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono font-medium tabular-nums">{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// EQUITY CURVE TAB
// ═══════════════════════════════════════════════════════════════════

function EquityCurveTab({ botId }: { botId: string }) {
  const curveQuery = useBotEquityCurve(botId);

  if (curveQuery.isLoading) return <div className="text-sm text-muted-foreground">Chargement…</div>;
  const curve = curveQuery.data?.curve ?? [];

  if (curve.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Pas encore de courbe equity. Clique &quot;Recalculer métriques&quot; pour générer.
      </div>
    );
  }

  const data = curve.map((p) => ({
    t: new Date(p.date).getTime(),
    equity: p.equityValueUsd,
    pnl: p.cumulativePnlUsd,
  }));
  const firstEquity = data[0]?.equity ?? 10000;
  const lastEquity = data[data.length - 1]?.equity ?? 10000;
  const totalReturn = firstEquity > 0 ? ((lastEquity - firstEquity) / firstEquity) * 100 : 0;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">Courbe equity ({curve.length} jours)</h3>
        <span className={`text-sm font-mono font-bold ${totalReturn >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600'}`}>
          {totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}%
        </span>
      </div>
      <div
        className="h-72 w-full"
        role="img"
        aria-label={`Courbe equity sur ${curve.length} jours : départ $${firstEquity.toFixed(0)}, fin $${lastEquity.toFixed(0)}, ${totalReturn >= 0 ? 'gain' : 'perte'} de ${Math.abs(totalReturn).toFixed(2)}%`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tick={{ fontSize: 10, fill: 'currentColor' }}
              tickFormatter={(t: number) => new Date(t).toLocaleDateString('fr-FR', { month: 'short', day: '2-digit' })}
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'currentColor' }}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
              domain={['auto', 'auto']}
            />
            <Tooltip
              contentStyle={{ fontSize: '11px', borderRadius: '6px' }}
              labelFormatter={(t) => new Date(Number(t)).toLocaleDateString('fr-FR')}
              formatter={(v) => [`$${Number(v).toFixed(2)}`, 'Equity']}
            />
            <ReferenceLine y={firstEquity} stroke="currentColor" strokeDasharray="4 4" opacity={0.3} />
            <Line
              type="monotone"
              dataKey="equity"
              stroke={totalReturn >= 0 ? '#10b981' : '#ef4444'}
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <table className="sr-only" aria-label="Données de la courbe equity">
        <caption>{`Courbe equity — ${curve.length} jours (échantillon)`}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Equity ($)</th>
            <th scope="col">P&amp;L cumulé ($)</th>
          </tr>
        </thead>
        <tbody>
          {sampleEquityPoints(data).map((p) => (
            <tr key={p.t}>
              <td>{new Date(p.t).toLocaleDateString('fr-FR')}</td>
              <td>{p.equity.toFixed(2)}</td>
              <td>{p.pnl.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sampleEquityPoints<T extends { t: number }>(points: T[]): T[] {
  if (points.length <= 10) return points;
  const step = Math.max(1, Math.floor(points.length / 10));
  const sampled = points.filter((_, i) => i % step === 0);
  const last = points[points.length - 1]!;
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

// ═══════════════════════════════════════════════════════════════════
// SESSIONS TAB
// ═══════════════════════════════════════════════════════════════════

function SessionsTab({ botId }: { botId: string }) {
  const sessionsQuery = useBotSessionMetrics(botId);

  if (sessionsQuery.isLoading) return <div className="text-sm text-muted-foreground">Chargement…</div>;
  const sessions = sessionsQuery.data?.sessions ?? [];

  if (sessions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Pas encore de métriques par contexte. Importe des trades avec <code>vix_at_entry</code> ou <code>regime</code> dans le CSV puis recalcule.
      </div>
    );
  }

  const byKind = {
    market_regime: sessions.filter((s) => s.sessionKind === 'market_regime'),
    vix_bucket: sessions.filter((s) => s.sessionKind === 'vix_bucket'),
    asset_class: sessions.filter((s) => s.sessionKind === 'asset_class'),
  };

  return (
    <div className="space-y-3">
      {Object.entries(byKind).map(([kind, list]) => list.length > 0 && (
        <SessionTable key={kind} title={labelForKind(kind)} sessions={list} />
      ))}
    </div>
  );
}

function labelForKind(kind: string): string {
  const labels: Record<string, string> = {
    market_regime: 'Par régime de marché',
    vix_bucket: 'Par bucket VIX',
    asset_class: 'Par classe d\'actif',
  };
  return labels[kind] ?? kind;
}

function SessionTable({ title, sessions }: { title: string; sessions: SessionMetrics[] }) {
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="text-left py-1.5 px-2">Contexte</th>
              <th className="text-right py-1.5 px-2">Trades</th>
              <th className="text-right py-1.5 px-2">Win rate</th>
              <th className="text-right py-1.5 px-2">Net PnL</th>
              <th className="text-right py-1.5 px-2">Expectancy</th>
              <th className="text-right py-1.5 px-2">Profit Factor</th>
              <th className="text-right py-1.5 px-2">Max DD</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {sessions.slice().sort((a, b) => b.netPnlUsd - a.netPnlUsd).map((s) => (
              <tr key={`${s.sessionKind}-${s.sessionValue}`} className="border-b">
                <td className="py-1.5 px-2 font-medium">{s.sessionValue}</td>
                <td className="text-right py-1.5 px-2">{s.tradesCount}</td>
                <td className={`text-right py-1.5 px-2 ${s.winRatePct >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {s.winRatePct.toFixed(0)}%
                </td>
                <td className={`text-right py-1.5 px-2 ${s.netPnlUsd >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {s.netPnlUsd >= 0 ? '+' : ''}${s.netPnlUsd.toFixed(2)}
                </td>
                <td className={`text-right py-1.5 px-2 ${s.expectancyUsd >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {s.expectancyUsd >= 0 ? '+' : ''}${s.expectancyUsd.toFixed(2)}
                </td>
                <td className="text-right py-1.5 px-2">
                  {s.profitFactor != null ? s.profitFactor.toFixed(2) : '—'}
                </td>
                <td className="text-right py-1.5 px-2 text-red-600">
                  -{s.maxDrawdownPct.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
