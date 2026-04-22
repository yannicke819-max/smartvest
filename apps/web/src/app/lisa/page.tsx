'use client';

import { useState, useEffect } from 'react';
import { Sparkles, Target, ShieldAlert, TrendingUp, Activity, ChevronDown, ChevronUp } from 'lucide-react';
import { usePortfolios } from '@/hooks/use-portfolio';
import { deduplicateSimulationPortfolios } from '@/app/actions/paper-portfolio';
import { useQueryClient } from '@tanstack/react-query';
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
import { LisaPortfolioChart } from '@/components/lisa/portfolio-chart';
import { LisaPositionsTable } from '@/components/lisa/positions-table';
import { LisaDecisionLog } from '@/components/lisa/decision-log';

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
  const qc = useQueryClient();
  const simulationPortfolios = (portfoliosQuery.data ?? []).filter(
    (p) => (p as { is_simulation?: boolean }).is_simulation,
  );

  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string | null>(
    simulationPortfolios[0]?.id ?? null,
  );

  // Bug fix critique : useState(...initial) ne réévalue PAS quand portfoliosQuery.data
  // arrive après le 1er render. Sans cet effet, selectedPortfolioId reste null,
  // handleSaveConfig fait return silencieux, et le bouton "Sauvegarder" semble inerte.
  useEffect(() => {
    if (!selectedPortfolioId && simulationPortfolios[0]?.id) {
      setSelectedPortfolioId(simulationPortfolios[0].id);
    }
  }, [simulationPortfolios, selectedPortfolioId]);

  // Déduplique silencieusement les portefeuilles de simulation au montage.
  useEffect(() => {
    if (simulationPortfolios.length > 1) {
      deduplicateSimulationPortfolios()
        .then((n) => { if (n > 0) qc.invalidateQueries({ queryKey: ['portfolios'] }); })
        .catch(() => {});
    }
  }, [simulationPortfolios.length]); // eslint-disable-line
  const [userFocus, setUserFocus] = useState('');
  const [killReason, setKillReason] = useState('');

  const configQuery = useLisaConfig(selectedPortfolioId);
  const upsertConfig = useUpsertLisaConfig(selectedPortfolioId ?? '');
  const generateProposal = useGenerateProposal(selectedPortfolioId ?? '');
  const proposalsQuery = useLisaProposals(selectedPortfolioId);
  const snapshotQuery = useLisaSnapshot(selectedPortfolioId);
  const killSwitch = useTriggerKillSwitch(selectedPortfolioId ?? '');

  const [profile, setProfile] = useState<SessionProfile>('sniper_mode');
  const [capital, setCapital] = useState('10000');
  const [antiConsensus, setAntiConsensus] = useState(9);
  const [enableCrypto, setEnableCrypto] = useState(true);
  const [autopilotEnabled, setAutopilotEnabled] = useState(false);
  const [autopilotCycleMin, setAutopilotCycleMin] = useState(15);
  const [localConfigSaved, setLocalConfigSaved] = useState(false);
  const [selectedScenarios, setSelectedScenarios] = useState<Set<string>>(new Set());
  const [scenariosExpanded, setScenariosExpanded] = useState(true);

  // Sync l'état local une seule fois quand la config arrive — ensuite l'UI
  // pilote elle-même les states (sinon checked={config?.X ?? local} override
  // les clics utilisateur).
  const [configSynced, setConfigSynced] = useState(false);
  useEffect(() => {
    if (config && !configSynced) {
      if (config.profile) setProfile(config.profile as SessionProfile);
      if (config.capital_usd) setCapital(String(config.capital_usd));
      if (typeof config.anti_consensus_strength === 'number') setAntiConsensus(config.anti_consensus_strength);
      if (typeof config.enable_crypto === 'boolean') setEnableCrypto(config.enable_crypto);
      if (typeof config.autopilot_enabled === 'boolean') setAutopilotEnabled(config.autopilot_enabled);
      if (typeof config.autopilot_cycle_minutes === 'number') setAutopilotCycleMin(config.autopilot_cycle_minutes);
      setConfigSynced(true);
    }
  }, [config, configSynced]);

  const config = configQuery.data;
  const canGenerate = !!(config ?? localConfigSaved);

  async function handleSaveConfig() {
    if (!selectedPortfolioId) return;
    await upsertConfig.mutateAsync({
      profile,
      capital_usd: capital,
      anti_consensus_strength: antiConsensus,
      enable_crypto: enableCrypto,
      autopilot_enabled: autopilotEnabled,
      autopilot_cycle_minutes: autopilotCycleMin,
    });
    setLocalConfigSaved(true);
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

      {/* Portfolio summary */}
      {selectedPortfolioId && (
        <LisaPortfolioSummary portfolioId={selectedPortfolioId} snapshot={snapshotQuery.data ?? null} />
      )}

      {/* Chart 1d/1w/1m/1y */}
      {selectedPortfolioId && <LisaPortfolioChart portfolioId={selectedPortfolioId} />}

      {/* Positions */}
      {selectedPortfolioId && <LisaPositionsTable portfolioId={selectedPortfolioId} />}

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
              value={profile}
              onChange={(e) => setProfile(e.target.value as SessionProfile)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              {Object.entries(PROFILE_LABELS).map(([key, { label }]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              {PROFILE_LABELS[profile].description}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium">Capital simulation (USD)</label>
            <input
              type="number"
              value={capital}
              onChange={(e) => setCapital(e.target.value)}
              min="100"
              step="100"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium">
              Anti-consensus strength : {antiConsensus} / 10
            </label>
            <input
              type="range"
              min="0"
              max="10"
              value={antiConsensus}
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
                checked={enableCrypto}
                onChange={(e) => setEnableCrypto(e.target.checked)}
              />
              Autoriser crypto (BTC, ETH, altcoins)
            </label>
          </div>
        </div>

        <div className="border-t pt-3 space-y-2">
          <label className="flex items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              checked={autopilotEnabled}
              onChange={(e) => setAutopilotEnabled(e.target.checked)}
            />
            Autopilot (génération automatique toutes les N minutes)
          </label>
          {autopilotEnabled && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground pl-6">
              <span>Fréquence :</span>
              <input
                type="number"
                min="5"
                max="1440"
                value={autopilotCycleMin}
                onChange={(e) => setAutopilotCycleMin(parseInt(e.target.value, 10))}
                className="h-7 w-20 rounded-md border bg-background px-2 text-xs"
              />
              <span>minutes</span>
              <span className="text-[10px] italic">· Les propositions sont générées mais requièrent toujours ton approbation pour ouvrir des positions (mode MANUAL_EXPLICIT)</span>
            </div>
          )}
        </div>

        <Button size="sm" onClick={handleSaveConfig} disabled={upsertConfig.isPending}>
          {upsertConfig.isPending ? 'Sauvegarde…' : 'Sauvegarder la config'}
        </Button>
      </div>

      {/* Generate proposal card */}
      <div className="rounded-lg border p-5 space-y-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Générer une proposition Lisa</h2>
        </div>

        {/* Scénarios multi-sélectables */}
        {(() => {
          const SCENARIO_GROUPS = [
            {
              label: 'Crypto',
              scenarios: [
                { id: 'btc_eth_breakout', label: '⚡ BTC/ETH breakout', value: 'breakout technique BTC ETH, momentum haussier, volume en hausse' },
                { id: 'altseason', label: '🪙 Altseason', value: 'rotation altcoins vs BTC, altseason signaux, momentum altcoins sous-valorisés' },
                { id: 'btc_dominance', label: '📊 BTC dominance', value: 'shift BTC dominance, arbitrage crypto, réallocation capital crypto' },
                { id: 'crypto_fear', label: '😱 Capitulation crypto', value: 'fear & greed extrême, capitulation crypto, position contrariante sur sur-vente' },
                { id: 'defi', label: '🔗 DeFi/L2', value: 'narratif DeFi Layer 2, tokens sous-valorisés, momentum protocoles émergents' },
              ],
            },
            {
              label: 'Indices & Actions',
              scenarios: [
                { id: 'spy_qqq_sniper', label: '🎯 SPY/QQQ sniper', value: 'niveaux clés SPY QQQ, rebond technique sur support, entrée précise sur pullback' },
                { id: 'us_momentum', label: '📈 Momentum US', value: 'actions US momentum fort, earnings surprise positif, flux institutionnels haussiers' },
                { id: 'short_squeeze', label: '🚀 Short squeeze', value: 'short interest élevé, catalyseur potentiel, squeeze candidats small cap' },
                { id: 'sector_rotation', label: '🔄 Rotation sectorielle', value: 'rotation énergie vers tech ou vice versa, arbitrage sectoriel, momentum relatif' },
                { id: 'small_cap', label: '🔬 Small cap breakout', value: 'small cap momentum, rupture technique, faible couverture analystes' },
              ],
            },
            {
              label: 'Macro & FX',
              scenarios: [
                { id: 'dxy_divergence', label: '💱 DXY divergence', value: 'divergence DXY, opportunité FX EURUSD USDJPY, impact dollar sur actifs' },
                { id: 'defensive', label: '🛡️ Défensif', value: 'refuge or GLD, obligations courte durée, couverture dollar fort, actifs défensifs' },
                { id: 'emerging', label: '🌍 Émergents', value: 'anomalie marchés émergents, divergence devise locale vs dollar, flux entrants' },
                { id: 'inflation_hedge', label: '🔥 Inflation hedge', value: 'couverture inflation, TIPS, or, matières premières, real assets' },
                { id: 'yield_curve', label: '📉 Courbe taux', value: 'exploitation courbe taux inversée, arbitrage obligations, duration play' },
              ],
            },
            {
              label: 'Matières premières',
              scenarios: [
                { id: 'oil_brent', label: '🛢️ Pétrole Brent', value: 'anomalie pétrole Brent WTI, cycle énergie, géopolitique impact offre' },
                { id: 'gold_silver', label: '🥇 Or/Argent', value: 'momentum or argent, ratio gold/silver, refuge valeur réelle' },
                { id: 'copper', label: '🏭 Cuivre/Industriels', value: 'cuivre cycle industriel, matières premières industrielles, signal croissance globale' },
                { id: 'agri', label: '🌾 Agriculture', value: 'anomalie prix agricoles, blé maïs soja, supply disruption saisonnière' },
              ],
            },
            {
              label: 'Volatilité & Spécial',
              scenarios: [
                { id: 'vix_spike', label: '🔮 Pic VIX', value: 'exploitation pic VIX, vente de volatilité post-panic, mean reversion rapide' },
                { id: 'anti_consensus', label: '⚠️ Anti-consensus max', value: 'position contrariante maximale, actifs sur-vendus extrêmes, panique de marché injustifiée' },
                { id: 'risk_on', label: '🟢 Risk-on global', value: 'rally généralisé risk-on, corrélation positive multi-asset, momentum toutes classes' },
                { id: 'risk_off', label: '🔴 Risk-off rotation', value: 'rotation risk-off, fuite vers qualité, vendre indices acheter défensif' },
                { id: 'event_driven', label: '📅 Event-driven', value: 'catalyseur événementiel imminent, earnings FOMC données macro, positionnement pre-event' },
              ],
            },
          ];

          const toggleScenario = (id: string) => {
            setSelectedScenarios((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              // Met à jour le focus avec la combinaison
              const all = SCENARIO_GROUPS.flatMap((g) => g.scenarios);
              const combined = all
                .filter((s) => next.has(s.id))
                .map((s) => s.value)
                .join(' | ');
              setUserFocus(combined);
              return next;
            });
          };

          const selectAll = () => {
            const all = SCENARIO_GROUPS.flatMap((g) => g.scenarios);
            setSelectedScenarios(new Set(all.map((s) => s.id)));
            setUserFocus(all.map((s) => s.value).join(' | '));
          };

          const clearAll = () => {
            setSelectedScenarios(new Set());
            setUserFocus('');
          };

          return (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setScenariosExpanded((v) => !v)}
                  className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  {scenariosExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  Scénarios ({selectedScenarios.size} sélectionné{selectedScenarios.size > 1 ? 's' : ''})
                </button>
                <div className="flex gap-2">
                  <button onClick={selectAll} className="text-[11px] text-primary hover:underline">Tout sélectionner</button>
                  <button onClick={clearAll} className="text-[11px] text-muted-foreground hover:underline">Effacer</button>
                </div>
              </div>

              {scenariosExpanded && (
                <div className="space-y-2.5">
                  {SCENARIO_GROUPS.map((group) => (
                    <div key={group.label}>
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {group.scenarios.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => toggleScenario(s.id)}
                            className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                              selectedScenarios.has(s.id)
                                ? 'border-primary bg-primary/10 font-medium text-primary'
                                : 'border-border hover:border-primary/50 hover:bg-muted'
                            }`}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* Champ libre */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-muted-foreground">Focus combiné (éditable)</label>
          <textarea
            value={userFocus}
            onChange={(e) => setUserFocus(e.target.value)}
            rows={3}
            placeholder="Sélectionne des scénarios ci-dessus ou écris ton focus librement…"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div className="flex items-center gap-3">
          <Button
            onClick={handleGenerate}
            disabled={generateProposal.isPending || !canGenerate}
          >
            <Sparkles className="mr-1.5 h-4 w-4" />
            {generateProposal.isPending ? 'Lisa analyse le marché…' : 'Générer propositions'}
          </Button>
          {selectedScenarios.size > 0 && (
            <span className="text-xs text-muted-foreground">{selectedScenarios.size} scénario{selectedScenarios.size > 1 ? 's' : ''} combiné{selectedScenarios.size > 1 ? 's' : ''}</span>
          )}
        </div>

        {!canGenerate && (
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

      {/* Decision log */}
      {selectedPortfolioId && <LisaDecisionLog portfolioId={selectedPortfolioId} />}

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
