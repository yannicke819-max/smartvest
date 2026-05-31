'use client';

// PR2 cost-cuts (H) — Panel UI Coûts Gemini + kill-switch + bouton "Relancer".
//
// Affiche :
//  - Coût quotidien Gemini ($X / cap $Y) avec barre de progression
//  - Coût mensuel cumulé
//  - Status (🟢 OK / 🟡 approaching / 🔴 blocked)
//  - Bouton "Relancer maintenant" visible UNIQUEMENT si killSwitchActive
//  - Bandeau info si manualOverrideActive (overrideAt + reason)
//  - Lien vers Google AI Studio billing pour vérification facturation réelle
//
// Le tracking interne sous-déclare ~5-50× la facturation Google réelle (cf.
// session 30/05). Un message informatif dans le panel le rappelle.

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, PlayCircle, RefreshCw } from 'lucide-react';
import {
  useGeminiCostStatus,
  useGeminiManualOverride,
  useGeminiClearOverride,
} from '@/hooks/use-gemini-cost';

export function GeminiCostPanel() {
  const statusQ = useGeminiCostStatus();
  const overrideMut = useGeminiManualOverride();
  const clearMut = useGeminiClearOverride();
  const [reasonInput, setReasonInput] = useState('');

  if (statusQ.isLoading) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
        Chargement coûts Gemini…
      </div>
    );
  }

  if (statusQ.isError || !statusQ.data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 p-4 text-sm text-red-700 dark:text-red-400">
        Erreur lecture coûts Gemini : {String(statusQ.error ?? 'unknown')}
      </div>
    );
  }

  const s = statusQ.data;
  const pct = Math.min(100, s.capUsedPct);
  const status: 'ok' | 'warn' | 'blocked' = s.killSwitchActive && !s.manualOverrideActive
    ? 'blocked'
    : pct >= 80
      ? 'warn'
      : 'ok';

  const colorClasses = {
    ok: 'border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/10',
    warn: 'border-amber-300 bg-amber-50 dark:bg-amber-950/20',
    blocked: 'border-red-400 bg-red-50 dark:bg-red-950/30',
  };
  const barColor = {
    ok: 'bg-emerald-500',
    warn: 'bg-amber-500',
    blocked: 'bg-red-500',
  };
  const statusIcon = {
    ok: <CheckCircle2 className="h-5 w-5 text-emerald-600" />,
    warn: <AlertTriangle className="h-5 w-5 text-amber-600" />,
    blocked: <AlertTriangle className="h-5 w-5 text-red-600" />,
  };
  const statusLabel = {
    ok: 'OK',
    warn: 'Attention — proche du cap',
    blocked: 'BLOQUÉ — kill-switch actif',
  };

  const handleOverride = async () => {
    const reason = reasonInput.trim() || undefined;
    await overrideMut.mutateAsync(reason);
    setReasonInput('');
  };

  return (
    <div className={`rounded-lg border p-4 ${colorClasses[status]}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">💰</span>
          <h3 className="font-semibold text-sm">Coûts Gemini (Google AI Studio)</h3>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {statusIcon[status]}
          <span className="font-medium">{statusLabel[status]}</span>
        </div>
      </div>

      {/* Coût quotidien + barre */}
      <div className="space-y-1.5 mb-3">
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Aujourd'hui</span>
          <span className="font-mono">
            ${s.todayUsd.toFixed(2)} / ${s.hardCapUsd.toFixed(2)} ({pct.toFixed(0)}%)
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full ${barColor[status]} transition-all`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      </div>

      {/* Coût mensuel */}
      <div className="flex justify-between text-xs mb-3">
        <span className="text-muted-foreground">Ce mois (tracking interne)</span>
        <span className="font-mono">${s.monthToDateUsd.toFixed(2)}</span>
      </div>

      {/* Bandeau override actif */}
      {s.manualOverrideActive && (
        <div className="rounded border border-blue-300 bg-blue-50 dark:bg-blue-950/20 p-2 text-xs mb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-blue-700 dark:text-blue-400">
              <PlayCircle className="h-3.5 w-3.5" />
              <span className="font-medium">Override manuel actif</span>
            </div>
            <button
              onClick={() => clearMut.mutate()}
              disabled={clearMut.isPending}
              className="text-blue-600 hover:underline disabled:opacity-50"
            >
              {clearMut.isPending ? 'Suspension…' : 'Suspendre'}
            </button>
          </div>
          {s.overrideAt && (
            <div className="text-blue-600 dark:text-blue-300 mt-1">
              Activé : {new Date(s.overrideAt).toLocaleTimeString('fr-FR')}
              {s.overrideReason && <span className="ml-1">— {s.overrideReason}</span>}
            </div>
          )}
          <div className="text-blue-600/70 dark:text-blue-400/70 mt-0.5 text-[10px]">
            Override valide jusqu'au reset automatique à minuit UTC
          </div>
        </div>
      )}

      {/* Bouton relancer si bloqué */}
      {status === 'blocked' && (
        <div className="rounded border border-red-300 bg-red-100/50 dark:bg-red-950/40 p-3 mb-3 space-y-2">
          <div className="text-xs text-red-700 dark:text-red-400">
            Toutes les actions Gemini (TRADER, Shadow, Risk Manager, Coach…) sont
            suspendues jusqu'au reset auto à minuit UTC, ou jusqu'à override manuel.
          </div>
          <input
            type="text"
            value={reasonInput}
            onChange={(e) => setReasonInput(e.target.value)}
            placeholder="Raison (optionnel) — ex: setup A++ détecté, debug, etc."
            className="w-full rounded border border-red-200 bg-white px-2 py-1 text-xs dark:bg-red-950/30 dark:border-red-700"
          />
          <button
            onClick={handleOverride}
            disabled={overrideMut.isPending}
            className="w-full flex items-center justify-center gap-1.5 rounded bg-red-600 hover:bg-red-700 text-white text-xs font-medium py-1.5 disabled:opacity-50"
          >
            {overrideMut.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Relance…
              </>
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5" />
                ⚡ Relancer maintenant (bypass kill-switch)
              </>
            )}
          </button>
        </div>
      )}

      {/* Footer infos */}
      <div className="text-[10px] text-muted-foreground space-y-0.5">
        <div>
          Reset auto : {new Date(s.nextResetUtc).toLocaleString('fr-FR')}
        </div>
        <div>
          ⚠ Tracking interne sous-déclare ~5-50× la facturation Google réelle.{' '}
          <a
            href="https://aistudio.google.com/usage"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5"
          >
            Vérifier Google AI Studio <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
