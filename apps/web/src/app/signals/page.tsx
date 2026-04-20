'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, AlertCircle, AlertTriangle, Info, Eye, Zap } from 'lucide-react';
import { useSignals, useIngestSignal, type SignalRow } from '@/hooks/use-signals';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';

const SEVERITY_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string; bg: string }> = {
  info: { label: 'Info', icon: <Info className="h-3.5 w-3.5" />, color: 'text-blue-600', bg: 'bg-blue-50' },
  watch: { label: 'Surveillance', icon: <Eye className="h-3.5 w-3.5" />, color: 'text-yellow-600', bg: 'bg-yellow-50' },
  warning: { label: 'Avertissement', icon: <AlertTriangle className="h-3.5 w-3.5" />, color: 'text-orange-600', bg: 'bg-orange-50' },
  critical: { label: 'Critique', icon: <AlertCircle className="h-3.5 w-3.5" />, color: 'text-red-600', bg: 'bg-red-50' },
  systemic: { label: 'Systémique', icon: <Zap className="h-3.5 w-3.5" />, color: 'text-red-700', bg: 'bg-red-100' },
};

const CATEGORY_LABELS: Record<string, string> = {
  central_bank_decision: 'Banque centrale',
  inflation_data: 'Inflation',
  growth_data: 'Croissance',
  employment_data: 'Emploi',
  fx_move: 'Devises',
  commodity_move: 'Matières premières',
  geopolitical_tension: 'Géopolitique',
  election_event: 'Élections',
  regulatory_change: 'Réglementation',
  market_stress: 'Stress marché',
  earnings_surprise: 'Résultats',
  credit_event: 'Crédit',
};

const INGEST_FORM_DEFAULTS = {
  title: '',
  summary: '',
  category: 'market_stress',
  sourceName: 'Manuel',
  severity: 'watch',
  confidence: 'medium',
  impactHorizon: 'short_term',
};

function SignalCard({ signal }: { signal: SignalRow }) {
  const cfg = SEVERITY_CONFIG[signal.severity] ?? SEVERITY_CONFIG.info;
  return (
    <Link href={`/signals/${signal.id}`}>
      <div className="rounded-lg border p-4 transition-colors hover:bg-muted/30 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${cfg.bg} ${cfg.color}`}>
              {cfg.icon}
              {cfg.label}
            </span>
            <span className="text-xs text-muted-foreground rounded bg-muted px-1.5 py-0.5">
              {CATEGORY_LABELS[signal.category] ?? signal.category}
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground flex-shrink-0">
            {new Date(signal.occurred_at).toLocaleDateString('fr-FR')}
          </span>
        </div>
        <p className="text-sm font-medium leading-snug">{signal.title}</p>
        {signal.summary && (
          <p className="text-xs text-muted-foreground line-clamp-2">{signal.summary}</p>
        )}
        {signal.affected_sectors?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {signal.affected_sectors.slice(0, 4).map((s) => (
              <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{s}</span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

export default function SignalsPage() {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(INGEST_FORM_DEFAULTS);
  const signalsQuery = useSignals();
  const ingestMutation = useIngestSignal();

  const signals = signalsQuery.data ?? [];

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await ingestMutation.mutateAsync(form);
    setForm(INGEST_FORM_DEFAULTS);
    setShowForm(false);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <DisclaimerBanner />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Signaux macro / géopolitiques</h1>
          <p className="text-sm text-muted-foreground">
            Signaux structurés normalisés. Pas de flux de news bruts. Chaque signal est contextualisé, analysé et limité en portée.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/market-context">
            <Button variant="outline" size="sm">Contexte marché</Button>
          </Link>
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Ingérer un signal
          </Button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border p-5 space-y-4">
          <h2 className="text-sm font-medium">Ingestion manuelle d'un signal</h2>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Titre</label>
            <input name="title" value={form.title} onChange={handleChange} required
              className="w-full rounded border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Catégorie</label>
              <select name="category" value={form.category} onChange={handleChange}
                className="w-full rounded border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring">
                {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Sévérité</label>
              <select name="severity" value={form.severity} onChange={handleChange}
                className="w-full rounded border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring">
                {Object.entries(SEVERITY_CONFIG).map(([v, c]) => <option key={v} value={v}>{c.label}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Confiance</label>
              <select name="confidence" value={form.confidence} onChange={handleChange}
                className="w-full rounded border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring">
                <option value="low">Faible</option>
                <option value="medium">Moyenne</option>
                <option value="high">Élevée</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Horizon d'impact</label>
              <select name="impactHorizon" value={form.impactHorizon} onChange={handleChange}
                className="w-full rounded border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring">
                <option value="immediate">Immédiat</option>
                <option value="short_term">Court terme</option>
                <option value="medium_term">Moyen terme</option>
                <option value="long_term">Long terme</option>
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Synthèse</label>
            <textarea name="summary" value={form.summary} onChange={handleChange} rows={3}
              className="w-full rounded border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={ingestMutation.isPending}>
              {ingestMutation.isPending ? 'Ingestion…' : 'Ingérer'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowForm(false)}>Annuler</Button>
          </div>
        </form>
      )}

      {signalsQuery.isLoading && (
        <div className="grid gap-3">{[1,2,3].map((i) => <SkeletonCard key={i} />)}</div>
      )}

      {!signalsQuery.isLoading && signals.length === 0 && (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          Aucun signal ingéré. Utilisez "Ingérer un signal" pour commencer.
        </div>
      )}

      <div className="grid gap-3">
        {signals.map((s) => <SignalCard key={s.id} signal={s} />)}
      </div>
    </div>
  );
}
