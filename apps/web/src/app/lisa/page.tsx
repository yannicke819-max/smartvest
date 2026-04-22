'use client';

import { useState } from 'react';
import { Sparkles, Target, ShieldAlert, TrendingUp, Activity } from 'lucide-react';
import { usePortfolios } from '@/hooks/use-portfolio';
import {
  useLisaConfig,
  useUpsertLisaConfig,
  useGenerateProposal,
  useLisaProposals,
  useLisaSnapshot,
  useTriggerKillSwitch,
  type SessionProfile,
} from '@/hooks/use-lisa';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { LisaProposalCard } from '@/components/lisa/proposal-card';
import { LisaPortfolioSummary } from '@/components/lisa/portfolio-summary';

const PROFILE_LABELS: Record<SessionProfile, { label: string; description: string }> = {
  long_term_investor: {
    label: 'Long terme',
    description: 'Horizon 6-24 mois, faible turnover, focus qualité + valuation',
  },
  active_trading: {
    label: 'Swing actif',
    description: 'Horizon 3-30 jours, flow + catalyseurs',
  },
  sniper_mode: {
    label: 'Sniper',
    description: 'Horizon < 5 jours, anomalies intraday, niveaux précis',
  },
  hyper_active: {
    label: 'Hyper-actif',
    description: 'Analyse continue, rebalance fréquent, simu intensive',
  },
};

export default function LisaPage() {
  const portfoliosQuery = usePortfolios();
  const simulationPortfolios = (portfoliosQuery.data ?? []).filter(
    (p) => (p as { is_simulation?: boolean }).is_simulation,
  );

  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string | null>(
    simulationPortfolios[0]?.id ?? null,
  );
  const [userFocus, setUserFocus] = useState('');
  const [killReason, setKillReason] = useState('');

  const configQuery = useLisaConfig(selectedPortfolioId);
  const upsertConfig = useUpsertLisaConfig(selectedPortfolioId ?? '');
  const generateProposal = useGenerateProposal(selectedPortfolioId ?? '');
  const proposalsQuery = useLisaProposals(selectedPortfolioId);
  const snapshotQuery = useLisaSnapshot(selectedPortfolioId);
  const killSwitch = useTriggerKillSwitch(selectedPortfolioId ?? '');

  const [profile, setProfile] = useState<SessionProfile>('long_term_investor');
  const [capital, setCapital] = useState('10000');
  const [antiConsensus, setAntiConsensus] = useState(7);
  const [enableCrypto, setEnableCrypto] = useState(true);

  const config = configQuery.data;

  async function handleSaveConfig() {
    if (!selectedPortfolioId) return;
    await upsertConfig.mutateAsync({
      profile,
      capital_usd: capital,
      anti_consensus_strength: antiConsensus,
      enable_crypto: enableCrypto,
    });
  }

  async function handleGenerate() {
    if (!selectedPortfolioId) return;
    await generateProposal.mutateAsync(userFocus.trim() || undefined);
    setUserFocus('');
  }

  async function handleKillSwitch() {
    if (!selectedPortfolioId) return;
    const reason = killReason.trim() || 'Manual kill';
    if (!confirm(`Fermer TOUTES les positions ? Raison : ${reason}`)) return;
    await killSwitch.mutateAsync(reason);
    setKillReason('');
  }

  // ── No simulation portfolio case ────────────────────────────────────────────
  if (!portfoliosQuery.isLoading && simulationPortfolios.length === 0) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <div className="flex items-center gap-3">
          <BackButton />
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Sparkles className="h-5 w-5 text-primary" />
              Lisa — AI Analyst
            </h1>
            <p className="text-sm text-muted-foreground">
              Multi-asset agnostic, anti-consensus, simulation-only
            </p>
          </div>
        </div>

        <DisclaimerBanner />

        <div className="rounded-lg border border-dashed p-10 text-center">
          <Sparkles className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Aucun portefeuille de simulation</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Lisa fonctionne uniquement sur des portefeuilles de simulation
            (100% virtuels, aucune connexion broker, aucun ordre réel).
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Crée un portefeuille de simulation depuis le dashboard (bouton
            "Simulation 10 000 € virtuels") pour commencer.
          </p>
        </div>
      </div>
    );
  }

  // ── Main UI ─────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Sparkles className="h-5 w-5 text-primary" />
            Lisa — AI Analyst Multi-Asset
          </h1>
          <p className="text-sm text-muted-foreground">
            Agnostique aux classes d'actifs · Anti-consensus · Corpus 25+ événements ·
            100 % simulation
          </p>
        </div>
      </div>

      <DisclaimerBanner />

      {/* Portfolio selector */}
      {simulationPortfolios.length > 1 && (
        <div className="space-y-1.5">
          <label className="block text-sm font-medium">Portefeuille de simulation</label>
          <select
            value={selectedPortfolioId ?? ''}
            onChange={(e) => setSelectedPortfolioId(e.target.value || null)}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          >
            {simulationPortfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Portfolio summary + chart preview */}
      {selectedPortfolioId && (
        <LisaPortfolioSummary portfolioId={selectedPortfolioId} snapshot={snapshotQuery.data ?? null} />
      )}

      {/* Config card */}
      <div className="rounded-lg border p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Configuration de session</h2>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium">Profile</label>
            <select
              value={config?.profile ?? profile}
              onChange={(e) => setProfile(e.target.value as SessionProfile)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              {Object.entries(PROFILE_LABELS).map(([key, { label }]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              {PROFILE_LABELS[(config?.profile ?? profile) as SessionProfile].description}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium">Capital simulation (USD)</label>
            <input
              type="number"
              value={config?.capital_usd ?? capital}
              onChange={(e) => setCapital(e.target.value)}
              min="100"
              step="100"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium">
              Anti-consensus strength : {config?.anti_consensus_strength ?? antiConsensus} / 10
            </label>
            <input
              type="range"
              min="0"
              max="10"
              value={config?.anti_consensus_strength ?? antiConsensus}
              onChange={(e) => setAntiConsensus(parseInt(e.target.value, 10))}
              className="w-full"
            />
            <p className="text-[10px] text-muted-foreground">
              0 = suit consensus · 10 = maximum contrarian
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={config?.enable_crypto ?? enableCrypto}
                onChange={(e) => setEnableCrypto(e.target.checked)}
              />
              Autoriser crypto (BTC, ETH, altcoins)
            </label>
          </div>
        </div>

        <Button size="sm" onClick={handleSaveConfig} disabled={upsertConfig.isPending}>
          {upsertConfig.isPending ? 'Sauvegarde…' : 'Sauvegarder la config'}
        </Button>
      </div>

      {/* Generate proposal card */}
      <div className="rounded-lg border p-5 space-y-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Générer une proposition Lisa</h2>
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium">Focus utilisateur (optionnel)</label>
          <textarea
            value={userFocus}
            onChange={(e) => setUserFocus(e.target.value)}
            rows={2}
            placeholder="Ex: focus défensif, ou rotation énergie, ou anomalies crypto…"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <Button
          onClick={handleGenerate}
          disabled={generateProposal.isPending || !config}
        >
          <Sparkles className="mr-1.5 h-4 w-4" />
          {generateProposal.isPending ? 'Lisa analyse le marché…' : 'Générer propositions'}
        </Button>

        {!config && (
          <p className="text-xs text-muted-foreground">
            Sauvegardez une configuration avant de générer.
          </p>
        )}

        {generateProposal.error && (
          <p className="text-xs text-destructive">
            Erreur : {(generateProposal.error as Error).message}
          </p>
        )}
      </div>

      {/* Proposals list */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Propositions récentes</h2>
        </div>

        {proposalsQuery.isLoading && <SkeletonCard />}

        {!proposalsQuery.isLoading && (proposalsQuery.data ?? []).length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Aucune proposition encore. Configure puis clique "Générer propositions".
          </div>
        )}

        {(proposalsQuery.data ?? []).map((p) => (
          <LisaProposalCard key={p.id} proposal={p} portfolioId={selectedPortfolioId ?? ''} />
        ))}
      </div>

      {/* Kill switch */}
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-5 space-y-3">
        <div className="flex items-center gap-2 text-destructive">
          <ShieldAlert className="h-4 w-4" />
          <h2 className="text-sm font-medium">Kill switch</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Ferme immédiatement TOUTES les positions ouvertes et désactive
          l'autopilot. Action irréversible pour le cycle courant.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={killReason}
            onChange={(e) => setKillReason(e.target.value)}
            placeholder="Raison (optionnel)"
            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
          />
          <Button
            variant="destructive"
            size="sm"
            onClick={handleKillSwitch}
            disabled={killSwitch.isPending}
          >
            {killSwitch.isPending ? 'Fermeture…' : 'Fermer toutes les positions'}
          </Button>
        </div>
      </div>
    </div>
  );
}
