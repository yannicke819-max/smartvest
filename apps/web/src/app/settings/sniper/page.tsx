'use client';

import { useState } from 'react';
import {
  Target, Lock, Unlock, ShieldAlert, AlertTriangle, Timer, History,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { BackButton } from '@/components/ui/back-button';
import {
  useSniperStatus,
  useSniperHistory,
  useUnlockSniper,
  useDeactivateSniper,
  type PersonalOverrideMode,
} from '@/hooks/use-sniper';

const MODE_LABEL: Record<PersonalOverrideMode, string> = {
  STANDARD: 'Standard',
  SNIPER_LOCKED: 'Verrouillé',
  SNIPER_ACTIVE: 'Sniper actif',
};

const MODE_STYLE: Record<PersonalOverrideMode, string> = {
  STANDARD: 'bg-slate-100 text-slate-700 border-slate-200',
  SNIPER_LOCKED: 'bg-amber-50 text-amber-700 border-amber-200',
  SNIPER_ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

function formatRemaining(s: number | null): string {
  if (s === null) return '—';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

export default function SniperPage() {
  const statusQuery = useSniperStatus();
  const historyQuery = useSniperHistory();
  const unlock = useUnlockSniper();
  const deactivate = useDeactivateSniper();

  const [code, setCode] = useState('');
  const [ttl, setTtl] = useState<number | ''>('');
  const [actionError, setActionError] = useState<string | null>(null);

  const status = statusQuery.data;
  const mode = status?.mode ?? 'STANDARD';

  function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setActionError(null);
    unlock.mutate(
      { code: code.trim(), ...(typeof ttl === 'number' ? { ttlMinutes: ttl } : {}) },
      {
        onSuccess: () => {
          setCode('');
          setTtl('');
        },
        onError: (e) => setActionError((e as Error).message),
      },
    );
  }

  function handleDeactivate() {
    setActionError(null);
    deactivate.mutate(undefined, {
      onError: (e) => setActionError((e as Error).message),
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Target className="h-5 w-5 text-muted-foreground" />
            Mode sniper
          </h1>
          <p className="text-sm text-muted-foreground">
            Surcouche personnelle, déverrouillable par code, TTL borné. Ne contourne aucun
            garde-fou ni mandat.
          </p>
        </div>
      </div>

      <DisclaimerBanner />

      {/* Safety notice */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold">Mode personnel avancé — non activé par défaut.</p>
            <p>
              Ce mode augmente la cadence d'analyse et la réactivité UX, mais ne déclenche
              AUCUNE exécution réelle automatiquement. Le mandat d'autonomie et le kill-switch
              restent prioritaires. La session expire automatiquement au bout du TTL choisi.
            </p>
          </div>
        </div>
      </div>

      {/* Current status */}
      {statusQuery.isLoading ? (
        <SkeletonCard />
      ) : (
        <div className="rounded-lg border p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">État actuel</p>
              <p className="mt-1 text-base font-semibold">{MODE_LABEL[mode]}</p>
            </div>
            <span className={`rounded-full border px-3 py-1 text-xs font-medium ${MODE_STYLE[mode]}`}>
              {mode === 'SNIPER_ACTIVE' ? (
                <span className="flex items-center gap-1">
                  <Unlock className="h-3 w-3" />
                  Déverrouillé
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <Lock className="h-3 w-3" />
                  {mode === 'SNIPER_LOCKED' ? 'Session terminée' : 'Standard'}
                </span>
              )}
            </span>
          </div>

          {mode === 'SNIPER_ACTIVE' && status?.session && (
            <>
              <div className="mt-4 flex items-center gap-2 text-sm">
                <Timer className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Temps restant :</span>
                <span className="font-mono text-base font-semibold tabular-nums text-emerald-700">
                  {formatRemaining(status.secondsRemaining)}
                </span>
                <span className="text-xs text-muted-foreground">
                  · Expire le {new Date(status.session.expires_at).toLocaleString('fr-FR', {
                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </div>
              <div className="mt-4">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDeactivate}
                  disabled={deactivate.isPending}
                >
                  <Lock className="mr-1.5 h-3.5 w-3.5" />
                  {deactivate.isPending ? 'Désactivation…' : 'Désactiver immédiatement'}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Unlock form (only when not active) */}
      {mode !== 'SNIPER_ACTIVE' && (
        <form onSubmit={handleUnlock} className="space-y-4 rounded-lg border p-5">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <Unlock className="h-4 w-4 text-muted-foreground" />
              Déverrouiller le mode sniper
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Entrez le code de déverrouillage local configuré côté serveur
              (<span className="font-mono text-[11px]">SNIPER_MODE_UNLOCK_CODE</span>).
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium">Code</label>
            <input
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoComplete="off"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              placeholder="••••••••"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium">
              TTL (minutes, optionnel)
            </label>
            <input
              type="number"
              min={1}
              max={240}
              value={ttl}
              onChange={(e) => setTtl(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
              placeholder="15"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm tabular-nums"
            />
            <p className="text-[11px] text-muted-foreground">
              Par défaut 15 min. Maximum 240 min. La session expire automatiquement.
            </p>
          </div>

          {actionError && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {actionError}
            </div>
          )}

          <Button type="submit" disabled={unlock.isPending || !code.trim()}>
            {unlock.isPending ? 'Déverrouillage…' : 'Déverrouiller'}
          </Button>
        </form>
      )}

      {/* History */}
      <section className="rounded-lg border">
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <History className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Historique des sessions</h2>
          <span className="ml-auto text-xs text-muted-foreground">Append-only</span>
        </header>
        {historyQuery.isLoading ? (
          <div className="p-4"><SkeletonCard /></div>
        ) : (historyQuery.data ?? []).length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">Aucune session.</p>
        ) : (
          <ol className="divide-y">
            {(historyQuery.data ?? []).map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                    s.status === 'unlocked'
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : s.status === 'revoked'
                      ? 'bg-slate-100 text-slate-700 border-slate-200'
                      : 'bg-amber-50 text-amber-700 border-amber-200'
                  }`}
                >
                  {s.status}
                </span>
                <span className="flex-1 text-muted-foreground">
                  {new Date(s.unlocked_at).toLocaleString('fr-FR', {
                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                  })}
                  {' → '}
                  {s.revoked_at
                    ? new Date(s.revoked_at).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' })
                    : new Date(s.expires_at).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  TTL {s.ttl_minutes}m
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
