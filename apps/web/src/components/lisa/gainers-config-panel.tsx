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
import Link from 'next/link';
import { Settings2, Save, RotateCcw, BarChart3, Bookmark, Trash2 } from 'lucide-react';
import {
  useGainersConfig,
  useUpdateGainersConfig,
  useGainersConfigPresets,
  useSaveGainersConfigPreset,
  useLoadGainersConfigPreset,
  useDeleteGainersConfigPreset,
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
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
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
    // PR Autopilot fix — Save ne force PLUS autopilot=true. Spec révisée :
    // l'autopilot est contrôlé UNIQUEMENT par le toggle dédié au-dessus.
    // Save sauvegarde les params modifiés sans toucher l'état autopilot
    // (sauf si l'utilisateur a explicitement flippé le toggle dans la
    // session draft).
    //
    // Comportement précédent (forçage true) provoquait le bug "F5 réactive
    // autopilot" : un Save subséquent à un toggle-OFF écrasait l'état.
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

  // PR Autopilot toggle — flip immédiat (pas besoin de Save).
  const handleToggleAutopilot = async () => {
    const newState = !(cfg.autopilot_enabled === true);
    try {
      await update.mutateAsync({ autopilot_enabled: newState });
      setError(null);
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
      <div className="flex items-center justify-between gap-2 text-orange-300">
        <div className="flex items-center gap-2">
          <Settings2 className="w-4 h-4" />
          <h3 className="text-sm font-semibold">Configuration scanner Gainers</h3>
        </div>
        <Link
          href={'/lisa/gainers/insights' as never}
          className="inline-flex items-center gap-1 text-xs text-orange-300 hover:text-orange-200"
        >
          <BarChart3 className="w-3 h-3" />
          Dashboard auto-learning
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        Tous les paramètres sont lus par le scanner à chaque cycle. Aucune
        valeur hardcodée — modifie librement, sauvegarde et l&apos;effet est
        immédiat au cycle suivant.
      </p>

      {/* 0. Autopilot toggle (top-level, prioritaire) */}
      <section
        className={`rounded-md border-2 p-3 flex items-center justify-between gap-3 ${
          cfg.autopilot_enabled === true
            ? 'border-emerald-500/60 bg-emerald-500/5'
            : 'border-red-500/60 bg-red-500/5'
        }`}
      >
        <div className="flex items-center gap-3">
          <div className={`text-2xl ${cfg.autopilot_enabled === true ? 'text-emerald-500' : 'text-red-500'}`}>
            {cfg.autopilot_enabled === true ? '🟢' : '🔴'}
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">
              Autopilot {cfg.autopilot_enabled === true ? 'ACTIF' : 'DÉSACTIVÉ'}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {cfg.autopilot_enabled === true
                ? 'Le scanner Gainers tourne sur ton portfolio à chaque cycle.'
                : '⚠ Le scanner ne tourne PAS — aucune ouverture/fermeture automatique.'}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={handleToggleAutopilot}
          disabled={update.isPending}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            cfg.autopilot_enabled === true
              ? 'bg-red-600 hover:bg-red-700 text-white'
              : 'bg-emerald-600 hover:bg-emerald-700 text-white'
          } disabled:opacity-50`}
        >
          {update.isPending
            ? '…'
            : cfg.autopilot_enabled === true
              ? 'Désactiver'
              : 'Activer'}
        </button>
      </section>

      {/* PR #265 — Sauvegardes nommées de config */}
      <PresetSection portfolioId={portfolioId} />

      {/* 1. Capital & sizing */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-foreground font-semibold">
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
        <div className="text-xs uppercase tracking-wider text-foreground font-semibold">
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
        <div className="text-xs uppercase tracking-wider text-foreground font-semibold">
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

      {/* PR #262 — Capital Rotation tempo */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-foreground font-semibold">
          3 bis. Capital rotation (toggle env GAINERS_CAPITAL_ROTATION_ENABLED)
        </div>
        <Field
          label="Délai stagnante avant rotation (min)"
          hint="[3..480] — durée minimale d'une position dans la dead zone (±0.3% pnl) avant qu'elle soit candidate à rotation. Default 90 min. Plus bas = plus réactif (whipsaw risk), plus haut = plus patient. Les seuils 3/5/10 sont pour scalping ultra-rapide."
        >
          <input
            type="number"
            min={3}
            max={480}
            step={1}
            value={num(cfg.gainers_rotation_stagnant_min_age_min, 90)}
            onChange={(e) => set('gainers_rotation_stagnant_min_age_min', Number(e.target.value))}
            className="input"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[3, 5, 10, 15, 30, 60, 90, 180].map((preset) => {
              const isActive = num(cfg.gainers_rotation_stagnant_min_age_min, 90) === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => set('gainers_rotation_stagnant_min_age_min', preset)}
                  className={
                    isActive
                      ? 'rounded-md border border-orange-500 bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-500'
                      : 'rounded-md border border-input bg-background px-2 py-0.5 text-xs text-muted-foreground hover:border-foreground hover:text-foreground'
                  }
                >
                  {preset} min
                </button>
              );
            })}
          </div>
        </Field>

        {/* PR #269 — pathEff rotation gate configurable */}
        <Field
          label="Min path efficiency du candidat A+ (rotation)"
          hint="[0..1] — qualité minimum du path du candidat pour autoriser la rotation. Distinct du Min path eff global (s'applique aux opens). Default 0.5 (strict). Baisse à 0.4 pour autoriser plus de rotations en mode Asia choppy. Mets 0 pour désactiver le gate."
        >
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={num(cfg.gainers_rotation_min_path_efficiency, 0.5)}
            onChange={(e) => set('gainers_rotation_min_path_efficiency', Number(e.target.value))}
            className="input"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[0, 0.3, 0.4, 0.5, 0.6, 0.7].map((preset) => {
              const isActive = num(cfg.gainers_rotation_min_path_efficiency, 0.5) === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => set('gainers_rotation_min_path_efficiency', preset)}
                  className={
                    isActive
                      ? 'rounded-md border border-orange-500 bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-500'
                      : 'rounded-md border border-input bg-background px-2 py-0.5 text-xs text-muted-foreground hover:border-foreground hover:text-foreground'
                  }
                >
                  {preset === 0 ? 'OFF' : preset.toFixed(2)}
                </button>
              );
            })}
          </div>
        </Field>

        {/* PR #270 — Post-SL cooldown par symbole */}
        <Field
          label="Cooldown après SL hit (min)"
          hint="[0..1440] — ban additionnel d'un symbole après un closed_stop. Évite le pattern SL → mini-rebond → re-open → SL again sur les downtrends. Distinct du cooldown global (qui s'applique à tout outcome TP/SL). Default 60 min. Mets OFF pour désactiver."
        >
          <input
            type="number"
            min={0}
            max={1440}
            step={5}
            value={num(cfg.gainers_post_sl_cooldown_min, 60)}
            onChange={(e) => set('gainers_post_sl_cooldown_min', Number(e.target.value))}
            className="input"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[0, 15, 30, 60, 120, 240].map((preset) => {
              const isActive = num(cfg.gainers_post_sl_cooldown_min, 60) === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => set('gainers_post_sl_cooldown_min', preset)}
                  className={
                    isActive
                      ? 'rounded-md border border-orange-500 bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-500'
                      : 'rounded-md border border-input bg-background px-2 py-0.5 text-xs text-muted-foreground hover:border-foreground hover:text-foreground'
                  }
                >
                  {preset === 0 ? 'OFF' : `${preset} min`}
                </button>
              );
            })}
          </div>
        </Field>

        {/* PR #271 — Asia strictness boost */}
        <Field
          label="Boost strictness Asia (path + persistence)"
          hint="[0..0.50] — booste les seuils min_path_efficiency et min_persistence pour les candidats asia_equity uniquement (compense la choppy nature des small-caps Asia). Ex: si tes seuils base sont 0.40 et 0.50, un boost de +0.10 les transforme en 0.50 et 0.60 sur Asia. Default +0.10. Mets 0 pour traiter Asia comme US/EU."
        >
          <input
            type="number"
            min={0}
            max={0.50}
            step={0.05}
            value={num(cfg.gainers_asia_strictness_boost, 0.10)}
            onChange={(e) => set('gainers_asia_strictness_boost', Number(e.target.value))}
            className="input"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[0, 0.05, 0.10, 0.15, 0.20, 0.30].map((preset) => {
              const isActive = num(cfg.gainers_asia_strictness_boost, 0.10) === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => set('gainers_asia_strictness_boost', preset)}
                  className={
                    isActive
                      ? 'rounded-md border border-orange-500 bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-500'
                      : 'rounded-md border border-input bg-background px-2 py-0.5 text-xs text-muted-foreground hover:border-foreground hover:text-foreground'
                  }
                >
                  {preset === 0 ? 'OFF' : `+${preset.toFixed(2)}`}
                </button>
              );
            })}
          </div>
        </Field>
      </section>

      {/* 4. Univers */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-foreground font-semibold">
          4. Univers de scan
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Toggle
            label="US equities (NYSE/NASDAQ)"
            checked={cfg.gainers_universe_us !== false}
            onChange={(v) => set('gainers_universe_us', v)}
          />
          <Toggle
            label="EU equities (LSE/XETRA/PA/AS/SW)"
            checked={cfg.gainers_universe_eu !== false}
            onChange={(v) => set('gainers_universe_eu', v)}
          />
          <Toggle
            label="Asia equities (TSE/HK/KO/KQ/NSE)"
            checked={cfg.gainers_universe_asia !== false}
            onChange={(v) => set('gainers_universe_asia', v)}
          />
          <Toggle
            label="Crypto (Binance majors+alts)"
            checked={cfg.gainers_universe_crypto !== false}
            onChange={(v) => set('gainers_universe_crypto', v)}
          />
        </div>
        <Toggle
          label="Filtre auto par horaires session"
          hint="Skip US/EU/Asia hors plages UTC. Crypto toujours actif. Économie ~30-50% appels EODHD."
          checked={cfg.gainers_session_filter_enabled !== false}
          onChange={(v) => set('gainers_session_filter_enabled', v)}
        />
      </section>

      {/* 4-bis. Force-close avant cloche */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-foreground font-semibold">
          4-bis. Force-close avant cloche
        </div>
        <Toggle
          label="Fermer auto les positions avant fermeture du marché"
          hint="Évite le gap risk overnight (US/EU/Asia). Crypto jamais affecté."
          checked={cfg.gainers_force_close_before_close_enabled === true}
          onChange={(v) => set('gainers_force_close_before_close_enabled', v)}
        />
        <Field
          label="Délai avant cloche (min)"
          hint="[5..120] — combien de minutes avant la fermeture déclencher le close. Default 30."
        >
          <input
            type="number"
            min={5}
            max={120}
            step={5}
            disabled={cfg.gainers_force_close_before_close_enabled !== true}
            value={num(cfg.gainers_force_close_offset_min, 30)}
            onChange={(e) => set('gainers_force_close_offset_min', Number(e.target.value))}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs disabled:opacity-50"
          />
        </Field>
      </section>

      {/* 5. Persistence + Path */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-foreground font-semibold">
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
        <div className="text-xs uppercase tracking-wider text-foreground font-semibold">
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

      {/* 7. Auto-learning (pWin ML gate) */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-foreground font-semibold">
          7. Auto-learning — Gate ML (pWin)
        </div>
        <p className="text-[11px] text-muted-foreground">
          Désactivé par défaut. Active uniquement après convergence du modèle
          (≥ 30 trades fermés + AUC ≥ 0.55). Si modèle pas prêt, le gate est
          automatiquement bypassé (fallback transparent).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Toggle
            label="Activer le gate pWin"
            checked={cfg.gainers_p_win_gate_enabled === true}
            onChange={(v) => set('gainers_p_win_gate_enabled', v)}
          />
          <Field label="Min pWin (probabilité win)" hint="[0..1] — default 0.50">
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={num(cfg.gainers_min_p_win, 0.5)}
              onChange={(e) => set('gainers_min_p_win', Number(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              disabled={cfg.gainers_p_win_gate_enabled !== true}
            />
          </Field>
        </div>
      </section>

      {/* 8. Adaptive Selectivity (PR #243) */}
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wider text-foreground font-semibold">
          8. Adaptive Selectivity (auto-ajustement seuils)
        </div>
        <p className="text-[11px] text-muted-foreground">
          Désactivé par défaut. Quand activé, un cron 5min lit le trajectory_status
          (basé sur réalisé 7j vs cible) et ajuste automatiquement les gates :
        </p>
        <ul className="text-[11px] text-muted-foreground list-disc list-inside space-y-0.5">
          <li><strong>EN_RETARD</strong> (&lt; 80% cible) : assouplit (persistence −0.05, path −0.05, max_per_cycle +1, cooldown ÷2)</li>
          <li><strong>EN_AVANCE</strong> (&gt; 110% cible) : aucune modif (préserve ton cap)</li>
          <li><strong>HORS_TRAJECTOIRE</strong> (réalisé négatif) : <span className="text-red-600 font-semibold">scanner OFF + alarme rouge</span></li>
          <li><strong>DANS_LE_PLAN</strong> : restore tes valeurs originales (snapshot)</li>
        </ul>
        <Toggle
          label="Activer l'Adaptive Selectivity"
          checked={cfg.gainers_adaptive_enabled === true}
          onChange={(v) => set('gainers_adaptive_enabled', v)}
        />
      </section>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2 border-t">
        <button
          type="button"
          onClick={handleSave}
          disabled={Object.keys(draft).length === 0 || update.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-md bg-orange-600 hover:bg-orange-500 disabled:bg-muted disabled:opacity-50 text-white text-sm font-medium"
          title="Sauvegarde les paramètres modifiés (autopilot piloté séparément par le toggle ci-dessus)"
        >
          <Save className="w-4 h-4" />
          {update.isPending ? 'Sauvegarde…' : 'Sauvegarder'}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={Object.keys(draft).length === 0}
          className="flex items-center gap-2 px-3 py-2 rounded-md border bg-background hover:bg-accent disabled:opacity-30 text-foreground text-sm"
        >
          <RotateCcw className="w-4 h-4" />
          Annuler
        </button>
        {saved && <span className="text-xs text-emerald-400">✓ Sauvegardé</span>}
        {error && <span className="text-xs text-red-400">✗ {error}</span>}
        {Object.keys(draft).length > 0 && !saved && !error && (
          <span className="text-xs text-muted-foreground">
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
      <span className="text-xs text-foreground font-medium">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 rounded border-input bg-background text-orange-500"
      />
      <div className="flex flex-col">
        <span className="text-sm text-foreground">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
    </label>
  );
}

/**
 * PR #265 — Section "Sauvegardes nommées" de config gainers.
 * Permet save/load/delete des presets nommés (ex: "Conservateur", "Crypto only").
 */
function PresetSection({ portfolioId }: { portfolioId: string }) {
  const [newName, setNewName] = useState('');
  const [confirmLoad, setConfirmLoad] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const presetsQuery = useGainersConfigPresets(portfolioId);
  const saveMut = useSaveGainersConfigPreset(portfolioId);
  const loadMut = useLoadGainersConfigPreset(portfolioId);
  const deleteMut = useDeleteGainersConfigPreset(portfolioId);

  const presets = presetsQuery.data?.presets ?? [];

  const handleSave = async () => {
    const name = newName.trim();
    if (!name) {
      setError('Nom requis');
      return;
    }
    try {
      await saveMut.mutateAsync(name);
      setNewName('');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleLoad = async (name: string) => {
    try {
      await loadMut.mutateAsync(name);
      setConfirmLoad(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Supprimer le preset "${name}" ?`)) return;
    try {
      await deleteMut.mutateAsync(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="space-y-3 border-t border-orange-900/30 pt-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-foreground font-semibold">
        <Bookmark className="w-3 h-3" />
        Mes configs sauvegardées
      </div>
      <p className="text-[11px] text-muted-foreground">
        Sauvegarde l&apos;état complet (TP/SL, gates, univers, rotation, etc.) sous
        un nom et recharge en 1 clic. Idéal pour tester différentes stratégies.
      </p>

      {/* Save current */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Nom du preset (ex: Conservateur, Crypto only)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          maxLength={60}
          className="h-8 flex-1 rounded-md border bg-background px-2 text-xs"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={saveMut.isPending || !newName.trim()}
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-orange-600 hover:bg-orange-700 text-white disabled:opacity-50 inline-flex items-center gap-1"
        >
          <Save className="w-3 h-3" />
          {saveMut.isPending ? '…' : 'Sauvegarder'}
        </button>
      </div>

      {/* List existing presets */}
      {presets.length > 0 && (
        <div className="space-y-1.5">
          {presets.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded border bg-card/50 px-2 py-1.5 text-xs"
            >
              <div className="flex-1 min-w-0">
                <span className="font-medium text-foreground">{p.name}</span>
                <span className="ml-2 text-[10px] text-muted-foreground">
                  · maj {new Date(p.updated_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              {confirmLoad === p.name ? (
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-amber-600">Écraser config courante ?</span>
                  <button
                    type="button"
                    onClick={() => handleLoad(p.name)}
                    disabled={loadMut.isPending}
                    className="px-2 py-0.5 rounded text-[10px] bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50"
                  >
                    {loadMut.isPending ? '…' : 'OK'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmLoad(null)}
                    className="px-2 py-0.5 rounded text-[10px] bg-slate-600 hover:bg-slate-700 text-white"
                  >
                    Annuler
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setConfirmLoad(p.name)}
                    className="px-2 py-0.5 rounded text-[10px] bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    Charger
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(p.name)}
                    disabled={deleteMut.isPending}
                    className="px-1.5 py-0.5 rounded text-[10px] bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                    title="Supprimer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {presets.length === 0 && !presetsQuery.isLoading && (
        <p className="text-[10px] text-muted-foreground italic">
          Aucun preset sauvegardé. Configure puis donne un nom pour le réutiliser plus tard.
        </p>
      )}
      {error && (
        <p className="text-[10px] text-red-500">{error}</p>
      )}
    </section>
  );
}

