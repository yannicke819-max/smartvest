'use client';

/**
 * PR Wizard.3 — UI Wizard LIVE Trading 6 steps.
 *
 * Composant unique avec stepper qui guide l'utilisateur de 'draft' à
 * 'live_active' en passant par : choix brokers → credentials → mandat
 * → sandbox tests → activation finale → monitoring.
 *
 * Le wizard NE flippe PAS BROKER_EXECUTION_ENABLED tant que step5
 * acknowledged. Tous les choix sont validés côté serveur.
 *
 * Bouton "Revert LIVE → Paper" toujours visible quand status='live_active'.
 */

import { useState } from 'react';
import { CheckCircle2, Circle, AlertTriangle, Power, Settings2, Briefcase, Shield } from 'lucide-react';
import {
  useWizardState,
  useStep1,
  useStep3,
  useActivateLive,
  useRevertToPaper,
} from '@/hooks/use-live-trading-wizard';

interface Props { portfolioId: string }

const STEPS = [
  { num: 1, label: 'Brokers', icon: Briefcase },
  { num: 2, label: 'Credentials', icon: Settings2 },
  { num: 3, label: 'Caps & mandate', icon: Shield },
  { num: 4, label: 'Sandbox tests', icon: Settings2 },
  { num: 5, label: 'Activation LIVE', icon: Power },
  { num: 6, label: 'Monitoring', icon: CheckCircle2 },
];

export function LiveTradingWizard({ portfolioId }: Props) {
  const { data: state, isLoading } = useWizardState(portfolioId);

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Chargement de l'installer LIVE…
      </div>
    );
  }

  if (!state) {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Aucun wizard initialisé.
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Power className="h-5 w-5 text-orange-500" />
        <h3 className="font-semibold text-foreground">Installer LIVE Trading</h3>
        <StatusBadge status={state.status} />
      </div>

      {/* Stepper */}
      <div className="flex items-center justify-between gap-1 overflow-x-auto pb-2">
        {STEPS.map((s) => {
          const done = state.current_step > s.num
            || (state.current_step === s.num && state.status === 'live_active');
          const active = state.current_step === s.num;
          return (
            <div
              key={s.num}
              className={`flex flex-col items-center gap-1 flex-1 min-w-[80px] ${
                done ? 'text-emerald-500' : active ? 'text-orange-500' : 'text-muted-foreground'
              }`}
            >
              {done ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : (
                <Circle className={`h-5 w-5 ${active ? 'fill-orange-500/20' : ''}`} />
              )}
              <span className="text-[10px] uppercase tracking-wider text-center">
                {s.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <div className="rounded-md border bg-background p-3">
        {state.current_step === 1 && state.status !== 'live_active' && (
          <Step1Content portfolioId={portfolioId} />
        )}
        {state.current_step === 2 && state.status !== 'live_active' && (
          <Step2Content state={state} />
        )}
        {state.current_step === 3 && state.status !== 'live_active' && (
          <Step3Content portfolioId={portfolioId} />
        )}
        {state.current_step === 4 && state.status === 'sandbox_running' && (
          <Step4Content state={state} />
        )}
        {state.current_step === 4 && state.status === 'sandbox_failed' && (
          <Step4FailedContent />
        )}
        {state.current_step === 5 && state.status === 'sandbox_passed' && (
          <Step5Content portfolioId={portfolioId} />
        )}
        {state.status === 'live_active' && <Step6Content portfolioId={portfolioId} state={state} />}
        {state.status === 'reverted' && (
          <div className="text-sm text-muted-foreground">
            LIVE désactivé — wizard en mode reverted. Re-démarrer une nouvelle config si besoin.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 1 ─────────────────────────────────────────────────────────────

function Step1Content({ portfolioId }: { portfolioId: string }) {
  const [useIbkr, setUseIbkr] = useState(true);
  const [useBinance, setUseBinance] = useState(false);
  const submit = useStep1(portfolioId);

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-foreground">Step 1 — Choisis tes brokers</div>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={useIbkr}
          onChange={(e) => setUseIbkr(e.target.checked)}
          className="mt-0.5 w-4 h-4"
        />
        <div>
          <div className="text-sm font-medium">Interactive Brokers Pro (recommandé)</div>
          <div className="text-xs text-muted-foreground">
            Stocks US/EU/Asia + options + crypto majors. Compte LLC US OK.
          </div>
        </div>
      </label>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={useBinance}
          onChange={(e) => setUseBinance(e.target.checked)}
          className="mt-0.5 w-4 h-4"
        />
        <div>
          <div className="text-sm font-medium">Binance.US (crypto only)</div>
          <div className="text-xs text-muted-foreground">
            Crypto majors uniquement. Compte business LLC OK.
          </div>
        </div>
      </label>
      <button
        onClick={() => submit.mutate({ use_ibkr: useIbkr, use_binance_us: useBinance })}
        disabled={(!useIbkr && !useBinance) || submit.isPending}
        className="rounded-md bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
      >
        {submit.isPending ? 'Validation…' : 'Suivant →'}
      </button>
      {submit.error && <div className="text-xs text-red-500">{String(submit.error)}</div>}
    </div>
  );
}

// ── Step 2 ─────────────────────────────────────────────────────────────

function Step2Content({ state }: { state: import('@/hooks/use-live-trading-wizard').WizardState }) {
  const step1 = state.step1_brokers;
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-foreground">Step 2 — Connecte tes credentials</div>
      <div className="text-xs text-muted-foreground">
        Va dans <a href="/settings/brokers/new" className="text-orange-500 underline">/settings/brokers/new</a>
        {' '}pour créer la connexion broker. Les credentials sont stockés dans Supabase Vault.
      </div>
      <div className="space-y-2 text-xs">
        {step1.use_ibkr && (
          <div className="rounded border bg-background p-2">
            <span className="font-medium">IBKR</span> — Account ID + Session Token (depuis Client Portal)
          </div>
        )}
        {step1.use_binance_us && (
          <div className="rounded border bg-background p-2">
            <span className="font-medium">Binance.US</span> — API Key + Secret Key (depuis API Management)
          </div>
        )}
      </div>
      <div className="text-xs text-muted-foreground italic">
        Une fois la connexion testée OK dans /settings/brokers, copie le <code>connection_id</code>
        {' '}retourné et reviens ici pour valider step 2.
      </div>
    </div>
  );
}

// ── Step 3 ─────────────────────────────────────────────────────────────

function Step3Content({ portfolioId }: { portfolioId: string }) {
  const [posPct, setPosPct] = useState(2);
  const [dailyPct, setDailyPct] = useState(10);
  const [drawdown, setDrawdown] = useState(5);
  const [days, setDays] = useState(30);
  const [maxOpen, setMaxOpen] = useState(5);
  const [classes, setClasses] = useState<string[]>(['us_equity_large', 'eu_equity', 'crypto_major']);
  const submit = useStep3(portfolioId);

  const toggleClass = (c: string) => {
    setClasses((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]);
  };

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-foreground">Step 3 — Configure tes garde-fous (mandate)</div>

      <SliderField label="Position max %" value={posPct} setValue={setPosPct} min={0.5} max={10} step={0.5} unit="%" />
      <SliderField label="Daily max %" value={dailyPct} setValue={setDailyPct} min={1} max={30} step={1} unit="%" />
      <SliderField label="Drawdown trigger %" value={drawdown} setValue={setDrawdown} min={1} max={20} step={1} unit="%" />

      <div>
        <div className="text-xs font-medium mb-1">Asset classes autorisées</div>
        <div className="flex flex-wrap gap-1.5">
          {['us_equity_large', 'us_equity_small_mid', 'eu_equity', 'asia_equity', 'crypto_major'].map((c) => {
            const active = classes.includes(c);
            return (
              <button
                key={c}
                onClick={() => toggleClass(c)}
                className={`rounded-md border px-2 py-0.5 text-xs ${
                  active ? 'border-orange-500 bg-orange-500/10 text-orange-500'
                  : 'border-input bg-background text-muted-foreground'
                }`}
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>

      <SliderField label="Max positions ouvertes" value={maxOpen} setValue={setMaxOpen} min={1} max={20} step={1} unit="" />
      <SliderField label="Mandate expire dans (jours)" value={days} setValue={setDays} min={7} max={90} step={1} unit="j" />

      <button
        onClick={() => submit.mutate({
          max_position_size_pct: posPct,
          max_single_trade_pct: posPct,
          max_daily_trade_pct: dailyPct,
          allowed_asset_classes: classes,
          forbidden_tickers: [],
          stop_loss_trigger_pct: drawdown,
          expires_in_days: days,
          max_open_positions: maxOpen,
        })}
        disabled={submit.isPending || classes.length === 0}
        className="rounded-md bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
      >
        {submit.isPending ? 'Création mandate…' : 'Créer le mandate →'}
      </button>
      {submit.error && <div className="text-xs text-red-500">{String(submit.error)}</div>}
    </div>
  );
}

// ── Step 4 ─────────────────────────────────────────────────────────────

function Step4Content({ state }: { state: import('@/hooks/use-live-trading-wizard').WizardState }) {
  const results = state.step4_sandbox_results as Record<string, unknown>;
  return (
    <div className="space-y-2 text-sm">
      <div className="font-medium text-foreground">Step 4 — Tests sandbox en cours</div>
      <div className="text-xs text-muted-foreground">
        Lance le scanner gainers en mode paper. Cron auto-validation surveille
        les 30 trades requis. Critères Go : drift fees &lt; 15%, slip &lt; 30bps,
        win rate ≥ 55%.
      </div>
      <div className="rounded-md bg-amber-500/10 border border-amber-500/30 p-2 text-xs">
        ⏳ Sandbox running — patience ~7-14 jours
        {Object.keys(results).length > 0 && (
          <pre className="mt-2 text-[10px]">{JSON.stringify(results, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

function Step4FailedContent() {
  return (
    <div className="space-y-2 text-sm">
      <div className="font-medium text-red-500">Step 4 — Sandbox FAILED</div>
      <div className="text-xs text-muted-foreground">
        Critères Go non atteints. Reviens à step 3 pour ajuster les caps ou
        attend que le scanner accumule plus de trades sandbox.
      </div>
    </div>
  );
}

// ── Step 5 ─────────────────────────────────────────────────────────────

function Step5Content({ portfolioId }: { portfolioId: string }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const activate = useActivateLive(portfolioId);

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-foreground">Step 5 — Activation LIVE</div>
      <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs">
        <div className="font-bold text-red-500 mb-1 flex items-center gap-1">
          <AlertTriangle className="h-4 w-4" /> POINT DE NON-RETOUR
        </div>
        Activer LIVE va flipper <code>BROKER_EXECUTION_ENABLED=true</code> et
        <code>DELEGATION_AUTONOMOUS_GUARDED=true</code> pour ce portfolio. À partir de
        ce moment les ordres seront envoyés au broker réel. Ton mandate est ton
        seul garde-fou — s'il est mal configuré, des pertes réelles peuvent survenir.
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="w-4 h-4"
        />
        <span className="text-sm">
          J'ai compris les risques. Je veux activer le mode LIVE avec mon mandate strict.
        </span>
      </label>
      <button
        onClick={() => activate.mutate(true)}
        disabled={!acknowledged || activate.isPending}
        className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
      >
        {activate.isPending ? 'Activation en cours…' : '🚨 Activer LIVE Trading'}
      </button>
      {activate.error && <div className="text-xs text-red-500">{String(activate.error)}</div>}
    </div>
  );
}

// ── Step 6 ─────────────────────────────────────────────────────────────

function Step6Content({ portfolioId, state }: { portfolioId: string; state: import('@/hooks/use-live-trading-wizard').WizardState }) {
  const revert = useRevertToPaper(portfolioId);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
        <div className="font-medium text-emerald-500 mb-1">✅ LIVE actif</div>
        <div className="text-xs text-foreground">
          Activé le {state.step5_activation_at?.slice(0, 19).replace('T', ' ')} UTC.
        </div>
      </div>
      <button
        onClick={() => {
          const reason = prompt('Raison du revert ?', 'Maintenance');
          if (reason) revert.mutate(reason);
        }}
        disabled={revert.isPending}
        className="rounded-md border border-red-500 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-500/20"
      >
        {revert.isPending ? 'Revert…' : '🛑 Revert LIVE → Paper'}
      </button>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    sandbox_running: 'bg-amber-500/10 text-amber-500',
    sandbox_passed: 'bg-emerald-500/10 text-emerald-500',
    sandbox_failed: 'bg-red-500/10 text-red-500',
    live_active: 'bg-emerald-500 text-white',
    live_paused: 'bg-red-500 text-white',
    reverted: 'bg-muted text-muted-foreground',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${styles[status] ?? 'bg-muted'}`}>
      {status.toUpperCase()}
    </span>
  );
}

function SliderField({
  label, value, setValue, min, max, step, unit,
}: {
  label: string; value: number; setValue: (n: number) => void;
  min: number; max: number; step: number; unit: string;
}) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-0.5">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium text-foreground">{value}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        className="w-full"
      />
    </div>
  );
}
