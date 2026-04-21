'use client';

import { useState } from 'react';
import { AlertTriangle, Zap, ZapOff, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMandates, useKillAll, useKillSwitch } from '@/hooks/use-mandate';

/**
 * Global emergency-stop banner rendered in the app shell header area.
 *
 * States:
 *  1. No active mandate → renders nothing.
 *  2. Active mandate, kill-switch OFF → shows a subtle pill + 2-step "Emergency Stop" trigger.
 *  3. Kill-switch ON on any active mandate → shows a full red banner with deactivation option.
 *
 * The 2-step confirmation prevents accidental activation:
 *   Step 1 — "Emergency Stop" pill clicked → inline confirmation dialog opens.
 *   Step 2 — User confirms → killAll() fires, writes audit events for every affected mandate.
 */
export function KillSwitchBanner() {
  const mandatesQuery = useMandates();
  const killAll = useKillAll();
  const killSwitch = useKillSwitch();

  const [confirmStep, setConfirmStep] = useState<'idle' | 'confirming'>('idle');
  const [deactivateId, setDeactivateId] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  const mandates = mandatesQuery.data ?? [];
  const activeMandates = mandates.filter((m) => m.status === 'active');
  const killedMandates = activeMandates.filter((m) => m.kill_switch_active);
  const liveMandate = activeMandates.find((m) => !m.kill_switch_active) ?? null;

  if (activeMandates.length === 0) return null;

  // ── Kill-switch IS active: full red banner ────────────────────────────────
  if (killedMandates.length > 0) {
    const first = killedMandates[0]!;
    return (
      <div
        role="alert"
        className="flex items-center gap-3 bg-red-600 px-4 py-2 text-sm text-white"
      >
        <ZapOff className="h-4 w-4 flex-shrink-0" aria-hidden />
        <span className="flex-1 font-medium">
          KILL-SWITCH ACTIF — Toutes les actions autonomes sont bloquées.
          {killedMandates.length > 1 && ` (${killedMandates.length} mandats concernés)`}
        </span>
        {deactivateId === first.id && confirmDeactivate ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-red-200">Confirmer la désactivation ?</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-white/50 bg-white/10 text-white hover:bg-white/20"
              onClick={() => {
                killSwitch.mutate({ id: first.id, activate: false });
                setDeactivateId(null);
                setConfirmDeactivate(false);
              }}
              disabled={killSwitch.isPending}
            >
              Oui, désactiver
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-white/70 hover:bg-white/10"
              onClick={() => { setDeactivateId(null); setConfirmDeactivate(false); }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-white/50 bg-white/10 text-white hover:bg-white/20"
            onClick={() => { setDeactivateId(first.id); setConfirmDeactivate(true); }}
          >
            <Zap className="mr-1.5 h-3.5 w-3.5" />
            Désactiver kill-switch
          </Button>
        )}
      </div>
    );
  }

  // ── Kill-switch is OFF, active mandate present: subtle emergency-stop pill ─
  if (!liveMandate) return null;

  return (
    <>
      {/* Inline confirmation dialog overlay */}
      {confirmStep === 'confirming' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-xl border bg-background p-6 shadow-xl">
            <div className="flex items-center gap-3 text-red-600">
              <AlertTriangle className="h-6 w-6 flex-shrink-0" />
              <h2 className="text-base font-semibold">Confirmer l'arrêt d'urgence</h2>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Cette action activera le kill-switch sur <strong>tous les mandats actifs</strong>.
              Toute action autonome sera immédiatement bloquée et un événement d'audit sera enregistré.
            </p>
            <p className="mt-2 text-sm font-medium text-red-600">
              Mandat concerné : {liveMandate.label}
            </p>
            <div className="mt-5 flex gap-3">
              <Button
                variant="destructive"
                className="flex-1"
                onClick={async () => {
                  await killAll.mutateAsync("Arrêt d'urgence déclenché manuellement par l'utilisateur");
                  setConfirmStep('idle');
                }}
                disabled={killAll.isPending}
              >
                <ZapOff className="mr-2 h-4 w-4" />
                {killAll.isPending ? 'Activation…' : 'Oui — bloquer toutes les actions'}
              </Button>
              <Button
                variant="outline"
                onClick={() => setConfirmStep('idle')}
                disabled={killAll.isPending}
              >
                Annuler
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Pill visible in header area */}
      <button
        type="button"
        onClick={() => setConfirmStep('confirming')}
        className="flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-100"
        title="Cliquez pour activer l'arrêt d'urgence"
      >
        <Zap className="h-3 w-3" aria-hidden />
        Emergency Stop
      </button>
    </>
  );
}
