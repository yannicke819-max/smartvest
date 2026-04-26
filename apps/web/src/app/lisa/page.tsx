'use client';

import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Target, ShieldAlert, TrendingUp, Activity, ChevronDown, ChevronUp } from 'lucide-react';
import { usePortfolios } from '@/hooks/use-portfolio';
import { deduplicateSimulationPortfolios } from '@/app/actions/paper-portfolio';
import { useQueryClient } from '@tanstack/react-query';
import {
  useLisaConfig,
  useUpsertLisaConfig,
  useLisaConfigRealtime,
  useGenerateProposal,
  useLisaProposals,
  useLisaSnapshot,
  useTriggerKillSwitch,
  useResetSimulation,
  useAgentStatus,
  type SessionProfile,
} from '@/hooks/use-lisa';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { LisaProposalCard } from '@/components/lisa/proposal-card';
import { LisaProposalsGroupedByDay } from '@/components/lisa/proposals-grouped-by-day';
import { LisaPortfolioSummary } from '@/components/lisa/portfolio-summary';
import { LisaPortfolioChart } from '@/components/lisa/portfolio-chart';
import { LisaPositionsTable } from '@/components/lisa/positions-table';
import { LisaDecisionLog } from '@/components/lisa/decision-log';
import { MechanicalAgentCard } from '@/components/lisa/mechanical-agent-card';
import { OptionPositionsCard } from '@/components/lisa/option-positions-card';

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
  // Sync temps réel cross-device : si la config est modifiée depuis un
  // autre appareil, le cache React Query local est invalidé automatiquement.
  useLisaConfigRealtime(selectedPortfolioId);
  const agentStatusQuery = useAgentStatus(selectedPortfolioId);
  const upsertConfig = useUpsertLisaConfig(selectedPortfolioId ?? '');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  // Auto-reset du feedback save après 4s, pour laisser le temps de lire
  // sans laisser le toast traîner indéfiniment.
  useEffect(() => {
    if (saveStatus === 'idle') return;
    const t = setTimeout(() => setSaveStatus('idle'), 4000);
    return () => clearTimeout(t);
  }, [saveStatus]);
  const generateProposal = useGenerateProposal(selectedPortfolioId ?? '');
  const proposalsQuery = useLisaProposals(selectedPortfolioId);
  const snapshotQuery = useLisaSnapshot(selectedPortfolioId);
  const killSwitch = useTriggerKillSwitch(selectedPortfolioId ?? '');
  const resetSim = useResetSimulation(selectedPortfolioId ?? '');

  const [profile, setProfile] = useState<SessionProfile>('sniper_mode');
  const [capital, setCapital] = useState('10000');
  const [antiConsensus, setAntiConsensus] = useState(9);
  const [enableCrypto, setEnableCrypto] = useState(true);
  const [autopilotEnabled, setAutopilotEnabled] = useState(false);
  const [autopilotCycleMin, setAutopilotCycleMin] = useState(15);
  const [autopilotAutoApprove, setAutopilotAutoApprove] = useState(false);
  const [autopilotExpiresAt, setAutopilotExpiresAt] = useState<string | null>(null);
  // Buffer string libre pour le champ "durée du sniper" — découplé de
  // autopilotExpiresAt pour que l'utilisateur puisse taper "10" sans que
  // la valeur recalculée à partir du timestamp ne le bloque à "1.0".
  const [autopilotDurationHoursInput, setAutopilotDurationHoursInput] = useState<string>('');
  // Timestamp d'expiration calculé UNE FOIS quand l'utilisateur change l'input,
  // pas à chaque render. Sans ce useMemo, new Date(Date.now() + h*3600000)
  // recalculerait à chaque re-render (toutes les 30-60s à cause des refetch
  // positions/snapshot) et l'heure affichée glisserait en avant.
  const autopilotComputedExpiryMs = useMemo<number | null>(() => {
    const trimmed = autopilotDurationHoursInput.trim();
    if (trimmed === '') return null;
    const h = parseFloat(trimmed);
    if (!Number.isFinite(h) || h <= 0) return null;
    return Date.now() + Math.min(h, 24) * 3_600_000;
  }, [autopilotDurationHoursInput]);
  const [autopilotAggressive, setAutopilotAggressive] = useState(false);
  const [autopilotMarketHoursOnly, setAutopilotMarketHoursOnly] = useState(false);
  // Preset risque actuellement sélectionné (visuel uniquement). Mis à jour
  // par applyPreset() ou dérivé depuis la config chargée si elle matche.
  const [activePreset, setActivePreset] = useState<'conservateur' | 'modere' | 'aggressive' | 'kamikaze' | null>(null);
  // Lisa v2 — objectifs de rendement nets + budget coûts (tous optionnels)
  const [returnTargetDaily, setReturnTargetDaily] = useState<string>('');
  const [returnTargetMonthly, setReturnTargetMonthly] = useState<string>('');
  const [returnTargetAnnual, setReturnTargetAnnual] = useState<string>('');
  const [dailyCostBudget, setDailyCostBudget] = useState<string>('');
  // Risk constraints — exposés dans l'UI (section avancée)
  const [targetDeploymentPct, setTargetDeploymentPct] = useState(60);
  const [maxPositionSizePct, setMaxPositionSizePct] = useState(25);
  const [maxExposurePerAssetClassPct, setMaxExposurePerAssetClassPct] = useState(40);
  const [maxOpenPositions, setMaxOpenPositions] = useState(10);
  const [maxDrawdown2DaysPct, setMaxDrawdown2DaysPct] = useState(10);
  // Avancé : levier + stop-loss par défaut + derivatives
  const [enableLeverage, setEnableLeverage] = useState(false);
  const [maxLeverage, setMaxLeverage] = useState(1.5);
  const [defaultStopLossPct, setDefaultStopLossPct] = useState(2);
  const [enableDerivatives, setEnableDerivatives] = useState(false);
  const [localConfigSaved, setLocalConfigSaved] = useState(false);
  const [selectedScenarios, setSelectedScenarios] = useState<Set<string>>(new Set());
  const [scenariosExpanded, setScenariosExpanded] = useState(true);

  const config = configQuery.data;
  const canGenerate = !!(config ?? localConfigSaved);

  // Sync l'état local une fois par portfolio_id quand la config arrive.
  // Si on change de portefeuille OU si la config est rechargée (après save),
  // on reset le flag pour resynchroniser.
  const [syncedForPortfolio, setSyncedForPortfolio] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedPortfolioId) return;
    if (!config) return;
    if (syncedForPortfolio === selectedPortfolioId) return;

    if (config.profile) setProfile(config.profile as SessionProfile);
    if (config.capital_usd) setCapital(String(config.capital_usd));
    if (typeof config.anti_consensus_strength === 'number') setAntiConsensus(config.anti_consensus_strength);
    if (typeof config.enable_crypto === 'boolean') setEnableCrypto(config.enable_crypto);
    if (typeof config.autopilot_enabled === 'boolean') setAutopilotEnabled(config.autopilot_enabled);
    if (typeof config.autopilot_cycle_minutes === 'number') setAutopilotCycleMin(config.autopilot_cycle_minutes);
    if (typeof config.autopilot_auto_approve === 'boolean') setAutopilotAutoApprove(config.autopilot_auto_approve);
    if (config.autopilot_expires_at) {
      setAutopilotExpiresAt(config.autopilot_expires_at);
      const remaining = new Date(config.autopilot_expires_at).getTime() - Date.now();
      if (remaining > 0) {
        setAutopilotDurationHoursInput((remaining / 3_600_000).toFixed(1));
      }
    }
    if (typeof config.autopilot_aggressive === 'boolean') setAutopilotAggressive(config.autopilot_aggressive);
    if (typeof config.autopilot_market_hours_only === 'boolean') setAutopilotMarketHoursOnly(config.autopilot_market_hours_only);
    // Lisa v2 — objectifs
    setReturnTargetDaily(config.return_target_daily_pct != null ? String(config.return_target_daily_pct) : '');
    setReturnTargetMonthly(config.return_target_monthly_pct != null ? String(config.return_target_monthly_pct) : '');
    setReturnTargetAnnual(config.return_target_annual_pct != null ? String(config.return_target_annual_pct) : '');
    setDailyCostBudget(config.daily_cost_budget_usd != null ? String(config.daily_cost_budget_usd) : '');
    const rc = config.risk_constraints ?? {};
    if (typeof rc.targetDeploymentPct === 'number') setTargetDeploymentPct(rc.targetDeploymentPct);
    if (typeof rc.maxPositionSizePct === 'number') setMaxPositionSizePct(rc.maxPositionSizePct);
    if (typeof rc.maxExposurePerAssetClassPct === 'number') setMaxExposurePerAssetClassPct(rc.maxExposurePerAssetClassPct);
    if (typeof rc.maxOpenPositions === 'number') setMaxOpenPositions(rc.maxOpenPositions);
    if (typeof rc.maxDrawdown2DaysPct === 'number') setMaxDrawdown2DaysPct(rc.maxDrawdown2DaysPct);
    if (typeof rc.maxLeverage === 'number') setMaxLeverage(rc.maxLeverage);
    if (typeof rc.defaultStopLossPct === 'number') setDefaultStopLossPct(rc.defaultStopLossPct);
    if (typeof config.enable_leverage === 'boolean') setEnableLeverage(config.enable_leverage);
    if (typeof config.enable_derivatives === 'boolean') setEnableDerivatives(config.enable_derivatives);
    // Détecte le preset matchant la config chargée pour highlight visuel.
    // Marqueurs uniques : maxPositionSizePct + enableLeverage + defaultStopLossPct.
    const pos = rc.maxPositionSizePct;
    const lev = config.enable_leverage;
    const stop = rc.defaultStopLossPct;
    if (pos === 5 && lev === false && stop === 3) setActivePreset('conservateur');
    else if (pos === 8 && lev === false && stop === 2) setActivePreset('modere');
    else if (pos === 25 && lev === true && stop === 2.5) setActivePreset('aggressive');
    else if (pos === 80 && lev === true && stop === 1) setActivePreset('kamikaze');
    else setActivePreset(null);
    setSyncedForPortfolio(selectedPortfolioId);
  }, [config, selectedPortfolioId, syncedForPortfolio]);

  /**
   * Pré-remplit tous les knobs risque/levier selon un preset.
   * L'utilisateur doit ensuite cliquer "Sauvegarder la config" pour appliquer.
   * Pas de save automatique — on évite les surprises et permet d'ajuster
   * un knob individuel après le preset.
   */
  function applyPreset(name: 'conservateur' | 'modere' | 'aggressive' | 'kamikaze') {
    setActivePreset(name);
    if (name === 'conservateur') {
      setProfile('long_term_investor');
      setReturnTargetDaily('0.05');
      setTargetDeploymentPct(60);
      setMaxPositionSizePct(5);
      setMaxExposurePerAssetClassPct(15);
      setMaxOpenPositions(10);
      setMaxDrawdown2DaysPct(5);
      setEnableLeverage(false);
      setMaxLeverage(1.0);
      setDefaultStopLossPct(3);
    } else if (name === 'modere') {
      setProfile('sniper_mode');
      setReturnTargetDaily('0.10');
      setTargetDeploymentPct(80);
      setMaxPositionSizePct(8);
      setMaxExposurePerAssetClassPct(20);
      setMaxOpenPositions(12);
      setMaxDrawdown2DaysPct(10);
      setEnableLeverage(false);
      setMaxLeverage(1.5);
      setDefaultStopLossPct(2);
    } else if (name === 'aggressive') {
      setProfile('hyper_active');
      setReturnTargetDaily('0.20');
      setTargetDeploymentPct(90);
      setMaxPositionSizePct(25);
      setMaxExposurePerAssetClassPct(50);
      setMaxOpenPositions(8);
      setMaxDrawdown2DaysPct(15);
      setEnableLeverage(true);
      setMaxLeverage(2.0);
      setDefaultStopLossPct(2.5);
    } else if (name === 'kamikaze') {
      setProfile('hyper_active');
      setReturnTargetDaily('0.30');
      setTargetDeploymentPct(95);
      setMaxPositionSizePct(80);
      setMaxExposurePerAssetClassPct(100);
      setMaxOpenPositions(3);
      setMaxDrawdown2DaysPct(25);
      setEnableLeverage(true);
      setMaxLeverage(3.0);
      setDefaultStopLossPct(1);
    }
  }

  async function handleSaveConfig() {
    if (!selectedPortfolioId) return;

    // Confirmation explicite la première fois qu'on active auto-approve
    if (autopilotAutoApprove && !config?.autopilot_auto_approve) {
      // Utilise le timestamp figé pour éviter tout décalage entre popup + save
      let durationLine: string;
      if (autopilotComputedExpiryMs === null) {
        durationLine = '• Durée : SANS LIMITE (jusqu\'à ce que tu désactives manuellement).';
      } else {
        const durH = parseFloat(autopilotDurationHoursInput);
        const clamped = Math.min(durH, 24);
        const expiry = new Date(autopilotComputedExpiryMs);
        durationLine = `• Durée : ${clamped} h → s'arrête automatiquement le ${expiry.toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}.`;
      }

      const ok = confirm(
        'ACTIVATION DU MODE AUTONOME\n\n'
        + '• Lisa ouvrira et fermera des positions toute seule sans te demander.\n'
        + `• Scan toutes les ${autopilotCycleMin} min.\n`
        + durationLine + '\n'
        + '• Simulation paper uniquement — aucune exécution réelle.\n'
        + '• Tu peux désactiver à tout moment en décochant la case.\n\n'
        + 'Confirmer ?',
      );
      if (!ok) {
        setAutopilotAutoApprove(false);
        return;
      }
    }

    // Helper : parseFloat ou null si vide / NaN
    const parseOrNull = (s: string): number | null => {
      const t = s.trim();
      if (t === '') return null;
      const v = parseFloat(t);
      return Number.isFinite(v) ? v : null;
    };

    try {
      await upsertConfig.mutateAsync({
        profile,
        capital_usd: capital,
        anti_consensus_strength: antiConsensus,
        enable_crypto: enableCrypto,
        autopilot_enabled: autopilotEnabled,
        autopilot_cycle_minutes: autopilotCycleMin,
        autopilot_auto_approve: autopilotAutoApprove,
        autopilot_aggressive: autopilotAggressive,
        autopilot_market_hours_only: autopilotMarketHoursOnly,
        return_target_daily_pct: parseOrNull(returnTargetDaily),
        return_target_monthly_pct: parseOrNull(returnTargetMonthly),
        return_target_annual_pct: parseOrNull(returnTargetAnnual),
        daily_cost_budget_usd: parseOrNull(dailyCostBudget),
        // Pas d'expiration par défaut — l'utilisateur veut "no-touch" sans limite
        // Utilise le timestamp figé calculé au moment de la saisie user
        // (pas Date.now() courant qui aurait drift entre la saisie et le save).
        autopilot_expires_at: (!autopilotAutoApprove || autopilotComputedExpiryMs === null)
          ? null
          : new Date(autopilotComputedExpiryMs).toISOString(),
        enable_leverage: enableLeverage,
        enable_derivatives: enableDerivatives,
        risk_constraints: {
          targetDeploymentPct,
          maxPositionSizePct,
          maxExposurePerAssetClassPct,
          maxOpenPositions,
          maxDrawdown2DaysPct,
          maxLeverage,
          defaultStopLossPct,
        },
      });
      setLocalConfigSaved(true);
      setSaveStatus('success');
      setSaveError(null);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : 'Erreur réseau');
    }
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

  async function handleResetSimulation() {
    if (!selectedPortfolioId) return;
    if (!confirm(
      'Effacer TOUT le portefeuille simulé ? Cela supprime définitivement positions, '
      + 'propositions, snapshots et décision log. Action irréversible.',
    )) return;
    await resetSim.mutateAsync();
  }

  async function handleActivateAutonomousHunter() {
    if (!selectedPortfolioId) return;
    const hoursStr = prompt(
      'Durée du mode chasse autonome (en heures). Laisse vide pour tourner sans expiration. '
      + 'SIMULATION uniquement — ouvre des positions paper sans confirmation à chaque cycle.',
      '4',
    );
    if (hoursStr === null) return; // cancel

    let expiresAt: string | null = null;
    const trimmed = hoursStr.trim();
    if (trimmed.length > 0) {
      const hours = parseFloat(trimmed);
      if (!Number.isFinite(hours) || hours <= 0) {
        alert('Durée invalide. Saisis un nombre positif ou laisse vide.');
        return;
      }
      expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
    }

    const expiryLine = expiresAt
      ? `• Expire automatiquement dans ${trimmed}h`
      : `• Sans expiration — tourne jusqu'à ce que tu désactives manuellement`;

    if (!confirm(
      `Activer le mode chasse autonome ?\n\n`
      + `• Lisa scanne le marché toutes les ${autopilotCycleMin || 15} min\n`
      + `• Elle OUVRE automatiquement les positions qu'elle juge EV+\n`
      + `• Elle COUPE sèchement les positions défavorables\n`
      + `• Simulation paper uniquement — aucune exécution réelle\n`
      + `• Kill-switch reste accessible à tout instant\n`
      + expiryLine,
    )) return;

    await upsertConfig.mutateAsync({
      autopilot_enabled: true,
      autopilot_cycle_minutes: autopilotCycleMin || 15,
      autopilot_auto_approve: true,
      autopilot_expires_at: expiresAt,
      autopilot_aggressive: true,
    });
    setAutopilotEnabled(true);
    setAutopilotAutoApprove(true);
    setAutopilotExpiresAt(expiresAt);
    setAutopilotAggressive(true);
  }

  async function handleDisableAutonomousHunter() {
    if (!selectedPortfolioId) return;
    // Arrêt immédiat : coupe auto-approve + persona agressive, mais laisse
    // autopilot_enabled pour continuer à recevoir des propositions manuelles.
    await upsertConfig.mutateAsync({
      autopilot_auto_approve: false,
      autopilot_expires_at: null,
      autopilot_aggressive: false,
    });
    setAutopilotAutoApprove(false);
    setAutopilotExpiresAt(null);
    setAutopilotDurationHoursInput('');
    setAutopilotAggressive(false);
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
      <div className="flex items-center justify-between gap-3">
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
        <a
          href="/news-analysis"
          className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100"
        >
          📰 News pipeline
        </a>
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

        {/* Lisa v2 — Objectifs de trajectoire + budget coûts (optionnels) */}
        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Objectifs de trajectoire (nets de coûts)
            </h3>
            <span className="text-[10px] text-muted-foreground">— optionnels, laisse vide si pas de cible</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="space-y-1">
              <label className="block text-[11px] font-medium">Cible daily (%)</label>
              <input
                type="number"
                step="0.01"
                value={returnTargetDaily}
                onChange={(e) => setReturnTargetDaily(e.target.value)}
                placeholder="ex: 0.15"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[11px] font-medium">Cible monthly (%)</label>
              <input
                type="number"
                step="0.1"
                value={returnTargetMonthly}
                onChange={(e) => setReturnTargetMonthly(e.target.value)}
                placeholder="ex: 3.5"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[11px] font-medium">Cible annual (%)</label>
              <input
                type="number"
                step="0.5"
                value={returnTargetAnnual}
                onChange={(e) => setReturnTargetAnnual(e.target.value)}
                placeholder="ex: 25"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[11px] font-medium">Budget coûts / jour ($)</label>
              <input
                type="number"
                step="0.1"
                min="0"
                value={dailyCostBudget}
                onChange={(e) => setDailyCostBudget(e.target.value)}
                placeholder="ex: 5.00"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Lisa compare la trajectoire réalisée 7j à ces cibles et ajuste sa
            sélectivité (EN AVANCE / DANS LE PLAN / EN RETARD / HORS TRAJECTOIRE).
            Le budget coûts déclenche un warning si dépassé — pas de blocage dur.
          </p>
        </div>

        <div className="border-t pt-3 space-y-2">
          <label className="flex items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              checked={autopilotEnabled}
              onChange={(e) => {
                setAutopilotEnabled(e.target.checked);
                if (!e.target.checked) {
                  // Désactiver autopilot → coupe aussi auto-approve + agressive
                  setAutopilotAutoApprove(false);
                  setAutopilotAggressive(false);
                }
              }}
            />
            Autopilot (mode event-driven + filet de garantie)
          </label>
          {autopilotEnabled && (
            <div className="pl-6 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Filet de garantie :</span>
                <input
                  type="number"
                  min="5"
                  max="60"
                  value={autopilotCycleMin}
                  onChange={(e) => setAutopilotCycleMin(parseInt(e.target.value, 10))}
                  className="h-7 w-20 rounded-md border bg-background px-2 text-xs"
                />
                <span>minutes</span>
                <span className="text-[10px] italic">· clamp 5-60 · default 30</span>
              </div>
              <p className="pl-0 text-[11px] text-muted-foreground italic">
                Lisa déclenche dès qu'un event matériel est détecté (VIX/DXY shift, prix tenu ±0.5%, funding crypto, news catalyst, drawdown). Ce filet force un cycle SI rien d'autre ne s'est déclenché pendant ce délai. 5 = très réactif (cher en API), 60 = passif.
              </p>

              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={autopilotAutoApprove}
                  onChange={(e) => setAutopilotAutoApprove(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Auto-approbation (no-touch)</span>
                  <span className="block text-[10px] text-muted-foreground">
                    Lisa ouvre et ferme les positions <strong>toute seule</strong> sans confirmation —
                    tu ne dois rien faire. Simulation paper uniquement.
                  </span>
                </span>
              </label>

              {autopilotAutoApprove && (
                <div className="pl-6 space-y-1">
                  <label className="text-xs font-medium">
                    Durée limitée (optionnelle, max 24 h)
                  </label>
                  <div className="flex items-center gap-2 text-xs">
                    <input
                      type="number"
                      min="0.5"
                      max="24"
                      step="0.5"
                      placeholder="vide = sans limite"
                      value={autopilotDurationHoursInput}
                      onChange={(e) => setAutopilotDurationHoursInput(e.target.value)}
                      className="h-7 w-24 rounded-md border bg-background px-2 text-xs"
                    />
                    <span className="text-muted-foreground">heures</span>
                    {autopilotComputedExpiryMs !== null && (() => {
                      const h = parseFloat(autopilotDurationHoursInput);
                      const expiry = new Date(autopilotComputedExpiryMs);
                      return (
                        <span className="text-[10px] text-amber-600">
                          → expirera {expiry.toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          {h > 24 && <span className="ml-1 text-red-500">(plafonné à 24 h)</span>}
                        </span>
                      );
                    })()}
                  </div>
                  <p className="text-[10px] text-muted-foreground italic">
                    Laisse vide pour tourner indéfiniment. Sinon l'auto-approbation se coupe
                    d'elle-même à l'expiration (l'autopilot continue à générer des propositions
                    mais sans auto-ouvrir). Kill-switch reste toujours accessible en permanence.
                  </p>
                </div>
              )}

              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={autopilotAggressive}
                  onChange={(e) => setAutopilotAggressive(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Persona agressive (chasseuse EV+)</span>
                  <span className="block text-[10px] text-muted-foreground">
                    Turnover élevé, stops serrés (−2 % floor), coupure sèche des perdantes,
                    scan multi-asset continu.
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={autopilotMarketHoursOnly}
                  onChange={(e) => setAutopilotMarketHoursOnly(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Heures de marché uniquement (économie ~45 %)</span>
                  <span className="block text-[10px] text-muted-foreground">
                    Lisa ne tourne que de 09 h à 22 h heure de Paris (07–20 h UTC) — couvre
                    Euronext + NYSE. Hors de cette fenêtre, les cycles sont skippés.
                    La nuit et le weekend, le risk monitor reste actif (stops auto).
                  </span>
                </span>
              </label>

              <div className={`rounded-md border p-2 text-[11px] ${
                autopilotAutoApprove
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200'
                  : 'border-blue-500/30 bg-blue-500/5 text-blue-900 dark:text-blue-200'
              }`}>
                {autopilotAutoApprove ? (
                  <>
                    <strong>Mode AUTONOME ACTIF</strong> — aucune action requise.
                    Lisa scanne toutes les {autopilotCycleMin} min et exécute elle-même.
                    {autopilotExpiresAt && (
                      <> Expire {new Date(autopilotExpiresAt).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}.</>
                    )}
                  </>
                ) : (
                  <>
                    <strong>Mode PROPOSITION</strong> — Lisa génère des idées toutes les {autopilotCycleMin} min
                    mais tu dois cliquer "Approuver" sur chaque proposition pour ouvrir les positions.
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="border-t pt-3 space-y-3">
          <h3 className="text-xs font-medium">Contraintes de risque</h3>
          <p className="text-[10px] text-muted-foreground -mt-1">
            Pilotent combien Lisa déploie et comment elle sizing. Respectées par
            le risk-enforcer au moment de la génération.
          </p>

          <div className="rounded-md border border-dashed p-3 space-y-2 bg-muted/30">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Presets risque · 1 clic</span>
              <span className="text-[10px] text-muted-foreground">cliquer puis « Sauvegarder la config »</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {([
                { key: 'conservateur', icon: '🛡️', label: 'Conservateur', sub: '5% pos · pas levier · stop 3%' },
                { key: 'modere',       icon: '⚖️', label: 'Modéré',       sub: '8% pos · pas levier · stop 2%' },
                { key: 'aggressive',   icon: '🔥', label: 'Aggressive',   sub: '25% pos · ×2 · stop 2.5%' },
                { key: 'kamikaze',     icon: '💀', label: 'Kamikaze',     sub: '80% pos · ×3 · stop 1%' },
              ] as const).map((p) => {
                const isActive = activePreset === p.key;
                const isKamikaze = p.key === 'kamikaze';
                const cls = isActive
                  ? 'rounded-md border-2 border-blue-500 ring-2 ring-blue-200 dark:ring-blue-900 bg-blue-50 dark:bg-blue-950/30 px-2 py-2 text-xs text-left transition-colors'
                  : isKamikaze
                  ? 'rounded-md border border-red-300/60 dark:border-red-900/60 px-2 py-2 text-xs hover:bg-red-50 dark:hover:bg-red-950/20 text-left transition-colors'
                  : 'rounded-md border px-2 py-2 text-xs hover:bg-muted text-left transition-colors';
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => applyPreset(p.key)}
                    className={cls}
                    aria-pressed={isActive}
                  >
                    <div className="font-medium flex items-center gap-1">
                      <span>{p.icon} {p.label}</span>
                      {isActive && <span className="text-blue-600 dark:text-blue-400">✓</span>}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{p.sub}</div>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground italic">
              ⚠️ Kamikaze : drawdown 25% possible en 2 jours. Activer seulement après backtest et Monte Carlo conclants.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">
              Déploiement cible : {targetDeploymentPct}% ({(100 - targetDeploymentPct)}% cash reserve)
            </label>
            <input
              type="range"
              min="10"
              max="95"
              step="5"
              value={targetDeploymentPct}
              onChange={(e) => setTargetDeploymentPct(parseInt(e.target.value, 10))}
              className="w-full"
            />
            <p className="text-[10px] text-muted-foreground">
              10 % = ultra-prudent · 95 % = fully invested (garder au moins 5 % cash buffer)
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Max par position (%)</label>
              <input
                type="number"
                min="1"
                max="100"
                value={maxPositionSizePct}
                onChange={(e) => setMaxPositionSizePct(parseFloat(e.target.value))}
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Max par classe d'actifs (%)</label>
              <input
                type="number"
                min="1"
                max="100"
                value={maxExposurePerAssetClassPct}
                onChange={(e) => setMaxExposurePerAssetClassPct(parseFloat(e.target.value))}
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Max positions ouvertes</label>
              <input
                type="number"
                min="1"
                max="50"
                value={maxOpenPositions}
                onChange={(e) => setMaxOpenPositions(parseInt(e.target.value, 10))}
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Max drawdown 2j (%) · hard kill</label>
              <input
                type="number"
                min="1"
                max="50"
                step="0.5"
                value={maxDrawdown2DaysPct}
                onChange={(e) => setMaxDrawdown2DaysPct(parseFloat(e.target.value))}
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              />
            </div>
          </div>

          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-4 space-y-3">
            <div>
              <h3 className="text-sm font-semibold">Avancé — Levier &amp; stop-loss</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Amplifie la sensibilité du portefeuille. Levier 2× = profits ET pertes ×2.
                Activer seulement après backtest et Monte Carlo conclants.
              </p>
            </div>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={enableLeverage}
                onChange={(e) => setEnableLeverage(e.target.checked)}
                className="mt-0.5"
              />
              <div className="text-xs">
                <strong>Activer le levier</strong>
                <p className="text-muted-foreground">
                  Lisa peut sizinger jusqu'au multiple ci-dessous. Coché = effective leverage autorisé.
                </p>
              </div>
            </label>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium">Levier max (×)</label>
                <input
                  type="number"
                  min="1"
                  max="5"
                  step="0.1"
                  value={maxLeverage}
                  onChange={(e) => setMaxLeverage(parseFloat(e.target.value))}
                  disabled={!enableLeverage}
                  className="h-8 w-full rounded-md border bg-background px-2 text-xs disabled:opacity-50"
                />
                <p className="text-[10px] text-muted-foreground">1.0 = pas de levier · 2.0 = ×2 sur l'exposition · 3.0 = aggressif</p>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Stop-loss par défaut (%)</label>
                <input
                  type="number"
                  min="0.5"
                  max="20"
                  step="0.5"
                  value={defaultStopLossPct}
                  onChange={(e) => setDefaultStopLossPct(parseFloat(e.target.value))}
                  className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                />
                <p className="text-[10px] text-muted-foreground">
                  Utilisé quand Lisa ne spécifie pas dans la thèse. 2 = serré · 3 = laisser respirer · 5 = large.
                </p>
              </div>
              <label className="flex items-start gap-2 cursor-pointer pt-5">
                <input
                  type="checkbox"
                  checked={enableDerivatives}
                  onChange={(e) => setEnableDerivatives(e.target.checked)}
                  className="mt-0.5"
                />
                <div className="text-xs">
                  <strong>Derivatives (options long-only)</strong>
                  <p className="text-muted-foreground">
                    Lisa reçoit IV ATM + put/call ratio dans son briefing. Si activé, peut proposer des <code>long_call</code> / <code>long_put</code> (30-45 DTE, ATM ou OTM léger) — exécutés en simulation via paper-broker. Pas de short naked.
                  </p>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Button size="sm" onClick={handleSaveConfig} disabled={upsertConfig.isPending}>
            {upsertConfig.isPending ? 'Sauvegarde…' : 'Sauvegarder la config'}
          </Button>
          {saveStatus === 'success' && (
            <span className="text-xs text-emerald-600 font-medium">
              ✓ Configuration sauvegardée
            </span>
          )}
          {saveStatus === 'error' && (
            <span className="text-xs text-red-600 font-medium">
              ✗ Échec de sauvegarde{saveError ? ` — ${saveError}` : ''}. Réessaie.
            </span>
          )}
        </div>
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

      {/* Proposals list — groupées par jour avec sections repliables */}
      <LisaProposalsGroupedByDay
        proposals={proposalsQuery.data ?? []}
        portfolioId={selectedPortfolioId ?? ''}
        isLoading={proposalsQuery.isLoading}
      />

      {/* Phase 4 — Dernier trigger event-driven + décompte safety_net */}
      {config?.last_event_trigger_reason && (
        <div className="rounded-md border bg-blue-50 dark:bg-blue-950/20 px-3 py-2 text-sm space-y-1">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
                ⚡ Dernier trigger Lisa
              </span>
              <span className="text-blue-900 dark:text-blue-100">
                {config.last_event_trigger_reason}
              </span>
            </div>
            {config.last_event_trigger_at && (
              <span className="text-xs text-muted-foreground">
                {new Date(config.last_event_trigger_at).toLocaleString('fr-FR', {
                  hour: '2-digit',
                  minute: '2-digit',
                  day: '2-digit',
                  month: '2-digit',
                })}
              </span>
            )}
          </div>
          <NextCycleCountdown
            lastTriggerAt={config.last_event_trigger_at as string | null}
            lastProposalAt={proposalsQuery.data?.[0]?.generated_at ?? null}
            killSwitchActive={(config.kill_switch_active as boolean) ?? false}
            autopilotEnabled={(config.autopilot_enabled as boolean) ?? false}
          />
        </div>
      )}

      {/* Agent mécanique */}
      <MechanicalAgentCard
        data={agentStatusQuery.data}
        isLoading={agentStatusQuery.isLoading}
      />

      {/* Options ouvertes (long calls/puts via OptionBrokerService) */}
      <OptionPositionsCard portfolioId={selectedPortfolioId} />

      {/* Decision log */}
      {selectedPortfolioId && <LisaDecisionLog portfolioId={selectedPortfolioId} />}

      {/* Statut mode autonome */}
      {autopilotEnabled && autopilotAutoApprove && (() => {
        const utcHour = new Date().getUTCHours();
        const inMarketHours = utcHour >= 7 && utcHour < 20;
        const isPausedByMarketHours = autopilotMarketHoursOnly && !inMarketHours;
        const nextResumeHour = autopilotMarketHoursOnly
          ? (utcHour < 7 ? 7 : 7 + 24) // 07:00 UTC aujourd'hui ou demain
          : null;
        return (
          <div className={`rounded-lg border p-4 flex items-center justify-between gap-3 ${
            isPausedByMarketHours
              ? 'border-orange-500/60 bg-orange-500/10'
              : 'border-amber-500/40 bg-amber-500/5'
          }`}>
            <div className={`flex items-center gap-2 ${
              isPausedByMarketHours ? 'text-orange-800 dark:text-orange-200' : 'text-amber-700 dark:text-amber-300'
            }`}>
              <Activity className="h-4 w-4 flex-shrink-0" />
              {isPausedByMarketHours ? (
                <span className="text-sm">
                  <strong>Mode AUTONOME EN PAUSE</strong> — l'option "Heures de marché uniquement" est active
                  et nous sommes hors fenêtre (7h–20h UTC).
                  Lisa reprendra automatiquement à {nextResumeHour !== null ? `${nextResumeHour % 24}h UTC` : '7h UTC'}
                  {' '}(09h Paris en été).
                </span>
              ) : (
                <span className="text-sm">
                  <strong>Mode AUTONOME actif</strong> — Lisa tourne toute seule toutes les {autopilotCycleMin} min.
                </span>
              )}
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDisableAutonomousHunter}
              disabled={upsertConfig.isPending}
            >
              Stop immédiat
            </Button>
          </div>
        );
      })()}

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

        <div className="pt-3 border-t border-destructive/20">
          <p className="text-xs text-muted-foreground mb-2">
            Reset complet : efface positions, propositions, snapshots et
            journal — retour à l'état initial sans P&L résiduel. À utiliser
            si le portefeuille contient des positions ouvertes avec des prix
            factices (ex : fallback avant fix).
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={handleResetSimulation}
            disabled={resetSim.isPending}
          >
            {resetSim.isPending ? 'Reset…' : 'Reset simulation (effacer tout)'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * NextCycleCountdown — décompte temps réel jusqu'au prochain cycle Lisa
 * forcé par le filet safety_net (30 min après le dernier cycle).
 *
 * Lisa peut tourner AVANT ce décompte si un event matériel est détecté
 * (VIX shift, prix tenu ±0.5%, funding crypto, news catalyst, etc.).
 * Ce décompte est donc un PLAFOND, pas un timing exact.
 *
 * Baseline = MAX(last_event_trigger_at, dernière proposal.created_at)
 * → couvre les cycles event ET safety_net ET bootstrap.
 */
function NextCycleCountdown(props: {
  lastTriggerAt: string | null;
  lastProposalAt: string | null;
  killSwitchActive: boolean;
  autopilotEnabled: boolean;
}) {
  const SAFETY_NET_MIN = 30;
  const RATE_LIMIT_MIN = 3;
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const baselineMs = useMemo(() => {
    const ts = [props.lastTriggerAt, props.lastProposalAt]
      .filter((t): t is string => Boolean(t))
      .map((t) => new Date(t).getTime());
    return ts.length > 0 ? Math.max(...ts) : 0;
  }, [props.lastTriggerAt, props.lastProposalAt]);

  if (!props.autopilotEnabled) {
    return (
      <div className="text-xs text-muted-foreground italic">
        Autopilot désactivé — pas de décompte automatique.
      </div>
    );
  }
  if (props.killSwitchActive) {
    return (
      <div className="text-xs text-red-600 dark:text-red-400 font-medium">
        🛑 Kill-switch actif — Lisa bloquée jusqu'à réactivation.
      </div>
    );
  }
  if (baselineMs === 0) {
    return (
      <div className="text-xs text-muted-foreground italic">
        Pas encore de baseline — prochain cycle imminent (bootstrap).
      </div>
    );
  }

  const now = Date.now();
  const elapsedMs = now - baselineMs;
  const elapsedMin = elapsedMs / 60_000;
  const safetyNetMs = baselineMs + SAFETY_NET_MIN * 60_000;
  const remainingMs = safetyNetMs - now;

  // En rate limit : aucun cycle possible avant 3 min écoulées
  if (elapsedMin < RATE_LIMIT_MIN) {
    const rateLimitRemaining = (RATE_LIMIT_MIN * 60_000 - elapsedMs) / 1000;
    const m = Math.floor(rateLimitRemaining / 60);
    const s = Math.floor(rateLimitRemaining % 60);
    return (
      <div className="text-xs text-amber-700 dark:text-amber-400 font-mono">
        ⏱️ Rate limit (3 min) — pas de cycle avant <strong>{m}m {s.toString().padStart(2, '0')}s</strong>
      </div>
    );
  }

  // Window event-driven : entre 3 min et 30 min, peut déclencher si event
  if (remainingMs <= 0) {
    return (
      <div className="text-xs text-emerald-700 dark:text-emerald-400 font-mono">
        ⚡ Cycle imminent — safety_net atteint, prochain tick autopilot (≤60s)
      </div>
    );
  }

  const m = Math.floor(remainingMs / 60_000);
  const s = Math.floor((remainingMs % 60_000) / 1000);
  return (
    <div className="text-xs text-blue-700 dark:text-blue-300 font-mono">
      🕐 Prochain cycle au plus tard dans <strong>{m}m {s.toString().padStart(2, '0')}s</strong>
      <span className="text-muted-foreground ml-1">
        (safety_net 30 min — peut déclencher avant si event matériel détecté)
      </span>
    </div>
  );
}
