'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Shield, ShieldOff, ShieldCheck, ShieldAlert, Plus, Zap, ZapOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { usePortfolios } from '@/hooks/use-portfolio';
import { BackButton } from '@/components/ui/back-button';
import {
  useMandates,
  useCreateMandate,
  useActivateMandate,
  useSuspendMandate,
  useRevokeMandate,
  useKillSwitch,
  useAuditEvents,
  type MandateRow,
  type CreateMandateInput,
} from '@/hooks/use-mandate';

const ASSET_CLASSES = ['equity', 'bond', 'etf', 'fund', 'commodity', 'crypto', 'real_estate', 'cash'] as const;

const STATUS_LABELS: Record<MandateRow['status'], string> = {
  pending_activation: 'En attente',
  active: 'Actif',
  suspended: 'Suspendu',
  expired: 'Expiré',
  revoked: 'Révoqué',
};

const STATUS_COLORS: Record<MandateRow['status'], string> = {
  pending_activation: 'text-yellow-600 bg-yellow-50',
  active: 'text-emerald-700 bg-emerald-50',
  suspended: 'text-orange-600 bg-orange-50',
  expired: 'text-gray-500 bg-gray-50',
  revoked: 'text-red-600 bg-red-50',
};

function defaultExpiry(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 6);
  return d.toISOString().slice(0, 16);
}

interface FormState {
  label: string;
  maxPositionSizePct: string;
  maxSingleTradePct: string;
  maxDailyTradePct: string;
  requiresHumanAbovePct: string;
  stopLossTriggerPct: string;
  maxOpenPositions: string;
  allowedAssetClasses: string[];
  forbiddenTickers: string;
  expiresAt: string;
}

function emptyForm(): FormState {
  return {
    label: '',
    maxPositionSizePct: '20',
    maxSingleTradePct: '10',
    maxDailyTradePct: '15',
    requiresHumanAbovePct: '5',
    stopLossTriggerPct: '10',
    maxOpenPositions: '',
    allowedAssetClasses: ['equity', 'etf'],
    forbiddenTickers: '',
    expiresAt: defaultExpiry(),
  };
}

function formToInput(form: FormState, portfolioId: string): CreateMandateInput {
  return {
    portfolioId,
    label: form.label.trim(),
    maxPositionSizePct: parseFloat(form.maxPositionSizePct),
    maxSingleTradePct: parseFloat(form.maxSingleTradePct),
    maxDailyTradePct: parseFloat(form.maxDailyTradePct),
    requiresHumanAbovePct: parseFloat(form.requiresHumanAbovePct),
    stopLossTriggerPct: parseFloat(form.stopLossTriggerPct),
    maxOpenPositions: form.maxOpenPositions ? parseInt(form.maxOpenPositions, 10) : undefined,
    allowedAssetClasses: form.allowedAssetClasses,
    forbiddenTickers: form.forbiddenTickers
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean),
    expiresAt: new Date(form.expiresAt).toISOString(),
  };
}

export default function DelegationPage() {
  const portfoliosQuery = usePortfolios();
  const portfolioId = portfoliosQuery.data?.[0]?.id ?? null;

  const mandatesQuery = useMandates(portfolioId ?? undefined);
  const auditQuery = useAuditEvents(portfolioId);
  const createMandate = useCreateMandate();
  const activateMandate = useActivateMandate();
  const suspendMandate = useSuspendMandate();
  const revokeMandate = useRevokeMandate();
  const killSwitch = useKillSwitch();

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleAssetClass(cls: string) {
    setForm((prev) => ({
      ...prev,
      allowedAssetClasses: prev.allowedAssetClasses.includes(cls)
        ? prev.allowedAssetClasses.filter((c) => c !== cls)
        : [...prev.allowedAssetClasses, cls],
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!portfolioId) return;
    setFormError(null);
    try {
      await createMandate.mutateAsync(formToInput(form, portfolioId));
      setShowForm(false);
      setForm(emptyForm());
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  const mandates = mandatesQuery.data ?? [];
  const activeMandate = mandates.find((m) => m.status === 'active') ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="text-xl font-semibold">Délégation — Mandats d'autonomie</h1>
          <p className="text-sm text-muted-foreground">
            Configurez les garde-fous avant d'activer le mode HYBRID_SUGGESTIVE ou AUTONOMOUS_GUARDED.
          </p>
        </div>
      </div>

      {/* Info block */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <strong>Rappel :</strong> Un mandat d'autonomie définit des plafonds stricts. Aucune action
        autonome n'est possible sans mandat actif et valide. L'autonomie n'est jamais le comportement
        par défaut — elle doit être explicitement mandatée.
      </div>

      {/* Active mandate banner */}
      {activeMandate && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
              <span className="font-medium text-emerald-800">Mandat actif : {activeMandate.label}</span>
              {activeMandate.kill_switch_active && (
                <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                  KILL-SWITCH ON
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="border-orange-300 text-orange-700 hover:bg-orange-50"
                onClick={() => killSwitch.mutate({
                  id: activeMandate.id,
                  activate: !activeMandate.kill_switch_active,
                })}
                disabled={killSwitch.isPending}
              >
                {activeMandate.kill_switch_active
                  ? <><ZapOff className="mr-1.5 h-3.5 w-3.5" />Désactiver kill-switch</>
                  : <><Zap className="mr-1.5 h-3.5 w-3.5" />Activer kill-switch</>}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-orange-300 text-orange-700 hover:bg-orange-50"
                onClick={() => suspendMandate.mutate({ id: activeMandate.id })}
                disabled={suspendMandate.isPending}
              >
                <ShieldOff className="mr-1.5 h-3.5 w-3.5" />
                Suspendre
              </Button>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-3 text-xs text-emerald-700">
            <div>Position max : {parseFloat(activeMandate.max_position_size_pct).toFixed(1)}%</div>
            <div>Trade max : {parseFloat(activeMandate.max_single_trade_pct).toFixed(1)}%</div>
            <div>Daily max : {parseFloat(activeMandate.max_daily_trade_pct).toFixed(1)}%</div>
            <div>Stop-loss : {parseFloat(activeMandate.stop_loss_trigger_pct).toFixed(1)}%</div>
            <div>Validation humaine si &gt; {parseFloat(activeMandate.requires_human_above_pct).toFixed(1)}%</div>
            <div>Expire : {new Date(activeMandate.expires_at).toLocaleDateString('fr-FR')}</div>
          </div>
        </div>
      )}

      {/* Mandate list */}
      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">Mandats ({mandates.length})</h2>
          <Button size="sm" onClick={() => setShowForm(!showForm)} variant="outline">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Nouveau mandat
          </Button>
        </div>

        {mandatesQuery.isLoading && (
          <div className="space-y-2 p-4">
            {[1, 2].map((i) => <SkeletonCard key={i} />)}
          </div>
        )}

        {mandates.length === 0 && !mandatesQuery.isLoading && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            Aucun mandat. Créez-en un pour configurer les garde-fous d'autonomie.
          </div>
        )}

        {mandates.map((mandate) => (
          <div key={mandate.id} className="flex items-center justify-between border-b p-4 last:border-0">
            <div>
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium text-sm">{mandate.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLORS[mandate.status]}`}>
                  {STATUS_LABELS[mandate.status]}
                </span>
                {mandate.kill_switch_active && (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
                    KS
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Expire {new Date(mandate.expires_at).toLocaleDateString('fr-FR')}
                {' · '}Classes : {mandate.allowed_asset_classes.join(', ')}
              </div>
            </div>
            <div className="flex gap-1.5">
              {mandate.status === 'pending_activation' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                  onClick={() => activateMandate.mutate(mandate.id)}
                  disabled={activateMandate.isPending}
                >
                  <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                  Activer
                </Button>
              )}
              {mandate.status === 'active' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-orange-300 text-orange-700"
                  onClick={() => suspendMandate.mutate({ id: mandate.id })}
                  disabled={suspendMandate.isPending}
                >
                  Suspendre
                </Button>
              )}
              {(mandate.status === 'pending_activation' || mandate.status === 'suspended') && (
                confirmRevoke === mandate.id ? (
                  <div className="flex gap-1">
                    <Button size="sm" variant="destructive"
                      onClick={() => { revokeMandate.mutate({ id: mandate.id }); setConfirmRevoke(null); }}
                      disabled={revokeMandate.isPending}
                    >
                      Confirmer révocation
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(null)}>
                      Annuler
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-600 hover:bg-red-50"
                    onClick={() => setConfirmRevoke(mandate.id)}
                  >
                    <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />
                    Révoquer
                  </Button>
                )
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border p-5 space-y-4">
          <h3 className="font-medium">Nouveau mandat d'autonomie</h3>
          {formError && (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {formError}
            </div>
          )}

          <Field label="Libellé *">
            <input
              className="w-full rounded border px-3 py-1.5 text-sm"
              value={form.label}
              onChange={(e) => setField('label', e.target.value)}
              placeholder="Ex: Mandat ETF prudent"
              required
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Position max (%)" hint="≤ 50%">
              <input type="number" min="0.1" max="50" step="0.1"
                className="w-full rounded border px-3 py-1.5 text-sm"
                value={form.maxPositionSizePct}
                onChange={(e) => setField('maxPositionSizePct', e.target.value)} />
            </Field>
            <Field label="Trade unique max (%)" hint="≤ position max">
              <input type="number" min="0.1" max="100" step="0.1"
                className="w-full rounded border px-3 py-1.5 text-sm"
                value={form.maxSingleTradePct}
                onChange={(e) => setField('maxSingleTradePct', e.target.value)} />
            </Field>
            <Field label="Volume journalier max (%)" hint="≤ 30%">
              <input type="number" min="0.1" max="30" step="0.1"
                className="w-full rounded border px-3 py-1.5 text-sm"
                value={form.maxDailyTradePct}
                onChange={(e) => setField('maxDailyTradePct', e.target.value)} />
            </Field>
            <Field label="Stop-loss déclencheur (%)" hint="≤ 25% drawdown">
              <input type="number" min="0.1" max="25" step="0.1"
                className="w-full rounded border px-3 py-1.5 text-sm"
                value={form.stopLossTriggerPct}
                onChange={(e) => setField('stopLossTriggerPct', e.target.value)} />
            </Field>
            <Field label="Validation humaine si (%)">
              <input type="number" min="0" max="100" step="0.1"
                className="w-full rounded border px-3 py-1.5 text-sm"
                value={form.requiresHumanAbovePct}
                onChange={(e) => setField('requiresHumanAbovePct', e.target.value)} />
            </Field>
            <Field label="Positions ouvertes max" hint="Optionnel">
              <input type="number" min="1" step="1"
                className="w-full rounded border px-3 py-1.5 text-sm"
                value={form.maxOpenPositions}
                placeholder="Illimité"
                onChange={(e) => setField('maxOpenPositions', e.target.value)} />
            </Field>
          </div>

          <Field label="Classes d'actifs autorisées *">
            <div className="flex flex-wrap gap-2 mt-1">
              {ASSET_CLASSES.map((cls) => (
                <button
                  key={cls}
                  type="button"
                  onClick={() => toggleAssetClass(cls)}
                  className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                    form.allowedAssetClasses.includes(cls)
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground border-border hover:border-primary/50'
                  }`}
                >
                  {cls}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Tickers interdits" hint="Séparés par des virgules, ex: GME, TSLA">
            <input
              className="w-full rounded border px-3 py-1.5 text-sm"
              value={form.forbiddenTickers}
              placeholder="GME, AMC, TSLA..."
              onChange={(e) => setField('forbiddenTickers', e.target.value)} />
          </Field>

          <Field label="Date d'expiration *" hint="Max 1 an">
            <input type="datetime-local"
              className="w-full rounded border px-3 py-1.5 text-sm"
              value={form.expiresAt}
              onChange={(e) => setField('expiresAt', e.target.value)} />
          </Field>

          <div className="flex gap-2 pt-1">
            <Button type="submit" disabled={createMandate.isPending}>
              {createMandate.isPending ? 'Création…' : 'Créer le mandat'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setShowForm(false); setForm(emptyForm()); setFormError(null); }}>
              Annuler
            </Button>
          </div>
        </form>
      )}

      {/* Audit trail */}
      {auditQuery.data && auditQuery.data.length > 0 && (
        <div className="rounded-lg border">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-medium">Journal d'audit ({auditQuery.data.length})</h2>
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Événement</th>
                  <th className="px-3 py-2 text-left">Raison</th>
                </tr>
              </thead>
              <tbody>
                {auditQuery.data.slice(0, 50).map((ev) => (
                  <tr key={ev.id} className="border-b last:border-0">
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">
                      {new Date(ev.occurred_at).toLocaleString('fr-FR')}
                    </td>
                    <td className="px-3 py-1.5 font-medium">{ev.kind}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{ev.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-foreground">
        {label}
        {hint && <span className="ml-1 font-normal text-muted-foreground">({hint})</span>}
      </label>
      {children}
    </div>
  );
}
