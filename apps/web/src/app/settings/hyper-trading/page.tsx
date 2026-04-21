'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Zap, ShieldAlert, AlertTriangle, Pause, Play, Power,
  History, CheckCircle2, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/states/error-state';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import {
  useHyperTradingConfig,
  useHyperTradingAudit,
  useConfigureHyperTrading,
  useActivateProfile,
  usePauseProfile,
  useResumeProfile,
  useKillProfile,
  type HyperTradingProfileRow,
  type HyperTradingGuardrailRow,
  type ProfileStatus,
} from '@/hooks/use-hyper-trading';

const STATUS_LABEL: Record<ProfileStatus, string> = {
  draft: 'Brouillon',
  active: 'Actif',
  paused: 'En pause',
  killed: 'Suspendu (kill-switch)',
  archived: 'Archivé',
};

const STATUS_STYLE: Record<ProfileStatus, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-200',
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  paused: 'bg-amber-50 text-amber-700 border-amber-200',
  killed: 'bg-red-50 text-red-700 border-red-200',
  archived: 'bg-slate-50 text-slate-500 border-slate-200',
};

export default function HyperTradingPage() {
  const configQuery = useHyperTradingConfig();
  const profile = configQuery.data?.profile ?? null;
  const guardrail = configQuery.data?.guardrail ?? null;
  const auditQuery = useHyperTradingAudit(profile?.id ?? null);

  const configure = useConfigureHyperTrading();
  const activate = useActivateProfile();
  const pause = usePauseProfile();
  const resume = useResumeProfile();
  const kill = useKillProfile();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [killReason, setKillReason] = useState('');
  const [confirmKill, setConfirmKill] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (configQuery.error) {
    return <ErrorState message={(configQuery.error as Error).message} />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <Header />
      <DisclaimerBanner />
      <SafetyBanner />

      {configQuery.isLoading ? (
        <SkeletonCard />
      ) : !profile ? (
        showCreateForm ? (
          <CreateProfileForm
            onCancel={() => setShowCreateForm(false)}
            onSubmit={(payload) =>
              configure.mutate(payload, {
                onSuccess: () => setShowCreateForm(false),
                onError: (e) => setActionError((e as Error).message),
              })
            }
            pending={configure.isPending}
            error={actionError}
          />
        ) : (
          <EmptyProfile onConfigure={() => setShowCreateForm(true)} />
        )
      ) : (
        <>
          <ProfileSummary profile={profile} />

          {/* Lifecycle actions */}
          <section className="rounded-lg border p-4 space-y-3">
            <h2 className="text-sm font-medium">Lifecycle</h2>
            <div className="flex flex-wrap gap-2">
              {profile.status === 'draft' && (
                <Button
                  size="sm"
                  onClick={() => activate.mutate(profile.id, {
                    onError: (e) => setActionError((e as Error).message),
                  })}
                  disabled={activate.isPending}
                >
                  {activate.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
                  Activer le profil
                </Button>
              )}
              {profile.status === 'active' && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => pause.mutate({ profileId: profile.id, reason: 'Pause manuelle depuis l\'UI' })}
                    disabled={pause.isPending}
                  >
                    <Pause className="mr-1.5 h-3.5 w-3.5" />
                    Mettre en pause
                  </Button>
                </>
              )}
              {profile.status === 'paused' && (
                <Button
                  size="sm"
                  onClick={() => resume.mutate({ profileId: profile.id, reason: 'Reprise manuelle' })}
                  disabled={resume.isPending}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  Reprendre
                </Button>
              )}
              {(profile.status === 'active' || profile.status === 'paused') && !confirmKill && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirmKill(true)}
                >
                  <Power className="mr-1.5 h-3.5 w-3.5" />
                  Kill-switch
                </Button>
              )}
            </div>

            {confirmKill && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 space-y-2">
                <p className="text-xs font-medium text-red-900">
                  Le kill-switch suspend immédiatement toute évaluation par le moteur. La reprise
                  nécessite une réactivation explicite.
                </p>
                <input
                  type="text"
                  value={killReason}
                  onChange={(e) => setKillReason(e.target.value)}
                  placeholder="Raison (obligatoire) — ex. anomalie détectée…"
                  className="h-8 w-full rounded border bg-background px-2 text-sm"
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!killReason.trim() || kill.isPending}
                    onClick={() => kill.mutate(
                      { profileId: profile.id, reason: killReason.trim() },
                      {
                        onSettled: () => { setConfirmKill(false); setKillReason(''); },
                        onError: (e) => setActionError((e as Error).message),
                      },
                    )}
                  >
                    {kill.isPending ? 'Kill-switch…' : 'Confirmer le kill-switch'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setConfirmKill(false); setKillReason(''); }}>
                    Annuler
                  </Button>
                </div>
              </div>
            )}

            {actionError && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {actionError}
              </div>
            )}
          </section>

          {guardrail && <GuardrailSummary guardrail={guardrail} />}

          {/* Audit log */}
          <section className="rounded-lg border">
            <header className="flex items-center gap-2 border-b px-4 py-3">
              <History className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Journal d'audit hyper-trading</h2>
              <span className="ml-auto text-xs text-muted-foreground">Hash-chainé · append-only</span>
            </header>
            {auditQuery.isLoading ? (
              <div className="p-4"><SkeletonCard /></div>
            ) : (auditQuery.data ?? []).length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">Aucun événement d'audit.</p>
            ) : (
              <ol className="divide-y">
                {(auditQuery.data ?? []).map((entry, i, arr) => (
                  <li key={entry.id} className="px-4 py-2.5 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                          #{arr.length - i}
                        </span>
                        <span className="font-medium">{entry.kind.replace(/_/g, ' ')}</span>
                      </div>
                      <span className="text-muted-foreground">
                        {new Date(entry.occurred_at).toLocaleString('fr-FR', {
                          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <p className="mt-0.5 text-muted-foreground">{entry.reason}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center gap-3">
      <Link href="/settings/strategy-mode">
        <Button variant="ghost" size="sm">
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Retour
        </Button>
      </Link>
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Zap className="h-5 w-5 text-amber-600" />
          Configuration hyper-trading
        </h1>
        <p className="text-sm text-muted-foreground">
          Mode opératoire personnel très actif. Strictement opt-in, garde-fous renforcés,
          kill-switch en un clic.
        </p>
      </div>
    </div>
  );
}

function SafetyBanner() {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-1">
          <p className="font-semibold">Mode personnel à risque élevé.</p>
          <p>
            Ce mode renforce — sans jamais les relâcher — les garde-fous du cadre de délégation.
            Aucune exécution réelle n'est jamais déclenchée par ce mode seul. Le moteur évalue les
            intents candidats ; toute action reste soumise au mandat et aux flags d'exécution.
          </p>
        </div>
      </div>
    </div>
  );
}

function EmptyProfile({ onConfigure }: { onConfigure: () => void }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center">
      <Zap className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
      <p className="text-sm font-medium">Aucun profil hyper-trading configuré</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Configurez un profil pour activer la cadence très active. Le profil reste en brouillon
        jusqu'à activation explicite.
      </p>
      <Button size="sm" className="mt-4" onClick={onConfigure}>
        Configurer un profil
      </Button>
    </div>
  );
}

function CreateProfileForm({
  onCancel, onSubmit, pending, error,
}: {
  onCancel: () => void;
  onSubmit: (payload: { tempo: 'HYPER_ACTIVE'; expiresAt: string; delegationMode: 'MANUAL_EXPLICIT' | 'HYBRID_SUGGESTIVE' | 'AUTONOMOUS_GUARDED'; windowTimezone: string; riskLevel: 'high' | 'very_high' }) => void;
  pending: boolean;
  error: string | null;
}) {
  const defaultExpiry = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 16);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [delegationMode, setDelegationMode] = useState<'MANUAL_EXPLICIT' | 'HYBRID_SUGGESTIVE' | 'AUTONOMOUS_GUARDED'>('MANUAL_EXPLICIT');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({
      tempo: 'HYPER_ACTIVE',
      riskLevel: 'very_high',
      delegationMode,
      windowTimezone: 'Europe/Paris',
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border p-5">
      <h2 className="text-sm font-semibold">Nouveau profil hyper-trading</h2>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium">Mode de délégation associé</label>
        <select
          value={delegationMode}
          onChange={(e) => setDelegationMode(e.target.value as typeof delegationMode)}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        >
          <option value="MANUAL_EXPLICIT">MANUAL_EXPLICIT — analyse intensive, validation manuelle systématique</option>
          <option value="HYBRID_SUGGESTIVE">HYBRID_SUGGESTIVE — suggestions intensives, revue par action</option>
          <option value="AUTONOMOUS_GUARDED">AUTONOMOUS_GUARDED — requiert mandat valide + garde-fous renforcés</option>
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium">Date d'expiration du profil</label>
        <input
          type="datetime-local"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          required
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        />
        <p className="text-[11px] text-muted-foreground">
          Le profil expire automatiquement et doit être renouvelé. Aucun profil permanent autorisé.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Annuler
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? 'Création…' : 'Créer le profil (brouillon)'}
        </Button>
      </div>
    </form>
  );
}

function ProfileSummary({ profile }: { profile: HyperTradingProfileRow }) {
  return (
    <div className="rounded-lg border p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Profil hyper-trading</p>
          <p className="mt-1 text-base font-semibold">{profile.tempo}</p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${STATUS_STYLE[profile.status]}`}>
          {STATUS_LABEL[profile.status]}
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div className="rounded-md bg-muted/30 p-3">
          <dt className="text-xs text-muted-foreground">Délégation</dt>
          <dd className="mt-0.5 font-medium">{profile.delegation_mode}</dd>
        </div>
        <div className="rounded-md bg-muted/30 p-3">
          <dt className="text-xs text-muted-foreground">Risque</dt>
          <dd className="mt-0.5 font-medium capitalize">{profile.risk_level.replace('_', ' ')}</dd>
        </div>
        <div className="rounded-md bg-muted/30 p-3">
          <dt className="text-xs text-muted-foreground">Expire le</dt>
          <dd className="mt-0.5 font-medium">{new Date(profile.expires_at).toLocaleDateString('fr-FR')}</dd>
        </div>
        <div className="rounded-md bg-muted/30 p-3">
          <dt className="text-xs text-muted-foreground">Kill-switch</dt>
          <dd className={`mt-0.5 font-medium ${profile.kill_switch_active ? 'text-red-700' : 'text-emerald-700'}`}>
            {profile.kill_switch_active ? 'Actif' : 'Désactivé'}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function GuardrailSummary({ guardrail }: { guardrail: HyperTradingGuardrailRow }) {
  const items = [
    { label: 'Trades / jour max', value: guardrail.max_trades_per_day },
    { label: 'Cooldown (min)', value: guardrail.cooldown_minutes_between_trades },
    { label: 'Cap notionnel / trade', value: `${guardrail.max_notional_per_trade_pct}%` },
    { label: 'Cap notionnel / jour', value: `${guardrail.max_daily_notional_pct}%` },
    { label: 'Stop-loss obligatoire', value: `${guardrail.mandatory_stop_loss_pct}%` },
    { label: 'Drawdown intraday max', value: `${guardrail.max_intraday_drawdown_pct}%` },
    { label: 'Perte journalière max', value: `${guardrail.max_daily_loss_pct}%` },
    { label: 'Spread max', value: `${guardrail.maximum_allowed_spread_bps} bp` },
    { label: 'Slippage max', value: `${guardrail.maximum_allowed_slippage_bps} bp` },
    { label: 'Volatilité max', value: `${guardrail.max_acceptable_volatility_pct}%` },
    { label: 'Positions ouvertes max', value: guardrail.max_open_positions },
    { label: 'Classes autorisées', value: guardrail.allowed_asset_classes.join(', ') },
  ];
  return (
    <section className="rounded-lg border p-5">
      <h2 className="text-sm font-medium">Garde-fous renforcés</h2>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
        {items.map((it) => (
          <div key={it.label} className="rounded-md bg-muted/30 p-2.5">
            <dt className="text-muted-foreground">{it.label}</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{it.value}</dd>
          </div>
        ))}
      </dl>
      {guardrail.denied_tickers.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Tickers interdits : <span className="font-mono">{guardrail.denied_tickers.join(', ')}</span>
        </p>
      )}
    </section>
  );
}
