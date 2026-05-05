'use client';

/**
 * PR #3 — Panel de configuration complet du mode Gainers.
 *
 * Migrations 0115 (full-config), 0089/0093 (cycle/path/TP/SL/persistence).
 * Tous les hardcodes du scanner deviennent éditables ici. La config est
 * persistée via POST /lisa/config/:portfolioId (validation API + clamps DB).
 *
 * Sections :
 *   1. Capital & sizing (capital_simulation, position_pct, max_open, max_per_cycle, cash_reserve)
 *   2. TP / SL (gainers_default_tp_pct, gainers_default_sl_pct)
 *   3. Cooldown re-entry (gainers_cooldown_minutes)
 *   4. Univers (toggles US / EU / Asia / Crypto)
 *   5. Persistence + Path quality (gainers_min_persistence_score, gainers_min_path_efficiency)
 *   6. Fees & profit minimum (gainers_fees_aware_buffer, gainers_min_net_profit_usd)
 */

import { useEffect, useState } from 'react';
import { Settings2, Save, RotateCcw } from 'lucide-react';
import {
  useGainersConfig,
  useUpdateGainersConfig,
  type GainersConfigFields,
} from '@/hooks/use-operating-mode';

interface Props {
  portfolioId: string;
}

type EditableConfig = Partial<GainersConfigFields>;

function num(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function GainersConfigPanel({ portfolioId }: Props) {
  const { data, isLoading } = useGainersConfig(portfolioId);
  const update = useUpdateGainersConfig(portfolioId);
  const [draft, setDraft] = useState<EditableConfig>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft({});
  }, [data]);

  if (isLoading || !data) {
    return (
      <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4 text-sm text-zinc-400">
        Chargement de la configuration…
      </div>
    );
  }

  const cfg = { ...data, ...draft };
  const set = <K extends keyof GainersConfigFields>(
    key: K,
    value: GainersConfigFields[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
    setError(null);
  };

  const handleSave = async () => {
    if (Object.keys(draft).length === 0) return;
    try {
      await update.mutateAsync(draft);
      setDraft({});
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  };

  const handleReset = () => {
    setDraft({});
    setError(null);
    setSaved(false);
  };

  // Capital & sizing
  const capital = num(cfg.capital_simulation, 10000);
  const positionPct = num(cfg.gainers_position_pct, 20);
  const maxOpen = num(cfg.gainers_max_open_positions, 5);
  const maxPerCycle = num(cfg.gainers_max_per_cycle, 3);
  const cashReservePct = num(cfg.gainers_cash_reserve_pct, 10);
  const positionUsd = capital * (positionPct / 100);
  const totalDeployedPct = positionPct * maxOpen + cashReservePct;
  const overAllocated = totalDeployedPct > 100;

  return (
    <div className="rounded-lg border border-orange-700/40 bg-orange-950/10 p-5 space-y-5">
      <div className="flex items-center gap-2 text-orange-300">
        <Settings2 className="w-4 h-4" />
        <h3 className="text-sm font-semibold">Configuration scanner Gainers</h3>
      </div>
      <p className="text-xs text-zinc-400">
        Tous les paramètres sont lus par le scanner à chaque cycle. Aucune
        valeur hardcodée — modifie librement, sauvegarde et l&apos;effet est
        immédiat au cycle suivant.
      </p>

      {/* 1. Capital & sizing */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-zinc-500 font-medium">
          1. Capital &amp; sizing
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Capital simulation (USD)">
            <input
              type="number"
              min={100}
              step={100}
              value={Number.isFinite(capital) ? capital : ''}
              onChange={(e) => set('capital_simulation', Number(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Notional / position (%)" hint={`= ${positionUsd.toFixed(0)} USD`}>
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={positionPct}
              onChange={(e) => set('gainers_position_pct', Number(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Max positions ouvertes" hint="[1..20]">
            <input
              type="number"
              min={1}
              max={20}
              step={1}
              value={maxOpen}
              onChange={(e) => set('gainers_max_open_positions', Number(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Max ouvertures / cycle" hint="[1..10]">
            <input
              type="number"
              min={1}
              max={10}
              step={1}
              value={maxPerCycle}
              onChange={(e) => set('gainers_max_per_cycle', Number(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Cash reserve (%)" hint="[0..50]">
            <input
              type="number"
              min={0}
              max={50}
              step={1}
              value={cashReservePct}
              onChange={(e) => set('gainers_cash_reserve_pct', Number(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
        </div>
        {overAllocated && (
          <div className="text-xs text-yellow-400">
            ⚠ Allocation théorique {totalDeployedPct.toFixed(0)}% &gt; 100% (position {positionPct}% × {maxOpen} + cash {cashReservePct}%). Le fees-aware guard refusera certaines ouvertures par manque de cash.
          </div>
        )}
      </section>

      {/* 2. TP / SL */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-zinc-500 font-medium">
          2. Take-profit / Stop-loss
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Take-profit défaut (%)" hint="(0, 50]">
            <input
              type="number"
              min={0.1}
              max={50}
              step={0.1}
              value={num(cfg.gainers_default_tp_pct, 1.5)}
              onChange={(e) => set('gainers_default_tp_pct', Number(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Stop-loss défaut (%)" hint="(0, 20]">
            <input
              type="number"
              min={0.1}
              max={20}
              step={0.1}
              value={num(cfg.gainers_default_sl_pct, 1.0)}
              onChange={(e) => set('gainers_default_sl_pct', Number(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
        </div>
      </section>

      {/* 3. Cooldown */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-zinc-500 font-medium">
          3. Cooldown re-entry
        </div>
        <Field label="Cooldown après close (min)" hint="[0..240] — refuse re-open même symbol/side avant ce délai">
          <input
            type="number"
            min={0}
            max={240}
            step={1}
            value={num(cfg.gainers_cooldown_minutes, 30)}
            onChange={(e) => set('gainers_cooldown_minutes', Number(e.target.value))}
            className="input"
          />
        </Field>
      </section>

      {/* 4. Univers */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-zinc-500 font-medium">
          4. Univers de scan
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Toggle
            label="🇺🇸 US equities"
            checked={cfg.gainers_universe_us !== false}
            onChange={(v) => set('gainers_universe_us', v)}
          />
          <Toggle
            label="🇪🇺 EU equities"
            checked={cfg.gainers_universe_eu !== false}
            onChange={(v) => set('gainers_universe_eu', v)}
          />
          <Toggle
            label="🌏 Asia equities"
            checked={cfg.gainers_universe_asia !== false}
            onChange={(v) => set('gainers_universe_asia', v)}
          />
          <Toggle
            label="🪙 Crypto"
            checked={cfg.gainers_universe_crypto !== false}
            onChange={(v) => set('gainers_universe_crypto', v)}
          />
        </div>
      </section>

      {/* 5. Persistence + Path */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-zinc-500 font-medium">
          5. Persistence multi-TF &amp; Path quality
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min persistence score" hint="[0..1] — fraction TFs positifs requis">
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={num(cfg.gainers_min_persistence_score, 0.67)}
              onChange={(e) => set('gainers_min_persistence_score', Number(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Min path efficiency" hint="[0..1] — anti pump-and-dump chaotique">
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={num(cfg.gainers_min_path_efficiency, 0.5)}
              onChange={(e) => set('gainers_min_path_efficiency', Number(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
        </div>
      </section>

      {/* 6. Fees & profit minimum */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-zinc-500 font-medium">
          6. Fees-aware &amp; profit minimum
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Fees-aware buffer (×)"
            hint="[1.0..5.0] — refuse open si gain attendu &lt; buffer × fees round-trip"
          >
            <input
              type="number"
              min={1.0}
              max={5.0}
              step={0.1}
              value={num(cfg.gainers_fees_aware_buffer, 2.0)}
              onChange={(e) => set('gainers_fees_aware_buffer', Number(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field
            label="Profit min net (USD)"
            hint="≥ 0 — refuse closed_target si net &lt; ce seuil"
          >
            <input
              type="number"
              min={0}
              max={9999}
              step={0.1}
              value={num(cfg.gainers_min_net_profit_usd, 0.5)}
              onChange={(e) => set('gainers_min_net_profit_usd', Number(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
        </div>
      </section>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2 border-t border-zinc-800">
        <button
          type="button"
          onClick={handleSave}
          disabled={Object.keys(draft).length === 0 || update.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-md bg-orange-600 hover:bg-orange-500 disabled:bg-zinc-700 disabled:opacity-50 text-white text-sm font-medium"
        >
          <Save className="w-4 h-4" />
          {update.isPending ? 'Sauvegarde…' : 'Sauvegarder'}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={Object.keys(draft).length === 0}
          className="flex items-center gap-2 px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 text-zinc-300 text-sm"
        >
          <RotateCcw className="w-4 h-4" />
          Annuler
        </button>
        {saved && <span className="text-xs text-emerald-400">✓ Sauvegardé</span>}
        {error && <span className="text-xs text-red-400">✗ {error}</span>}
        {Object.keys(draft).length > 0 && !saved && !error && (
          <span className="text-xs text-zinc-500">
            {Object.keys(draft).length} modif(s) en attente
          </span>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-zinc-300">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-zinc-500">{hint}</span>}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded border-zinc-600 bg-zinc-900 text-orange-500"
      />
      <span className="text-sm text-zinc-200">{label}</span>
    </label>
  );
}
