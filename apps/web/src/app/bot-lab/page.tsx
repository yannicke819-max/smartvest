'use client';

import { useState } from 'react';
import Link from 'next/link';
import { FlaskConical, Upload, Plus, Trash2, FileText, ArrowLeft } from 'lucide-react';
import {
  useBots,
  useBotTrades,
  useCreateBot,
  useDeleteBot,
  useImportCsv,
  type BotDefinition,
  type BotSourceType,
} from '@/hooks/use-bot-lab';

export default function BotLabPage() {
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);

  return (
    <div className="container mx-auto p-4 space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
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
            Bot Profitability Lab
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Importe des bots externes (CSV ou stratégies), mesure leurs perfs avec
            métriques standardisées (Sharpe, Sortino, MaxDD, Profit Factor) et
            extrais les patterns robustes pour les transférer à Lisa.
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
            Phase 1 (en cours) : import CSV + journal normalisé. Phases 2-4 à venir : performance engine, pattern miner, transfer layer.
          </p>
        </div>
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
  const [showCreateForm, setShowCreateForm] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Mes bots ({botsQuery.data?.bots.length ?? 0})</h2>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 flex items-center gap-1"
        >
          <Plus className="h-3 w-3" />
          Nouveau bot
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
  const [csvText, setCsvText] = useState('');

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
    } catch (e) {
      alert(`Erreur import: ${String(e).slice(0, 200)}`);
    }
  };

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="text-xs text-muted-foreground hover:underline flex items-center gap-1"
      >
        <ArrowLeft className="h-3 w-3" />
        Retour à la liste
      </button>

      {/* Import CSV */}
      <div className="rounded-lg border p-4 space-y-3">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Upload className="h-4 w-4 text-muted-foreground" />
          Importer des trades CSV
        </h3>
        <p className="text-xs text-muted-foreground">
          Format : <code className="font-mono">symbol,direction,entry_timestamp,entry_price,quantity,exit_timestamp,exit_price</code>
          <br />
          Optionnels : <code>asset_class</code>, <code>exit_reason</code>, <code>entry_notional_usd</code>, <code>net_pnl_usd</code>, <code>external_id</code>.
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
            {importMut.isPending ? 'Import…' : 'Importer'}
          </button>
        )}
      </div>

      {/* Trades list */}
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
    </div>
  );
}
