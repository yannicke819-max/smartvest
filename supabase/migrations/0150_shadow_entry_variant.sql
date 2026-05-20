-- 0150 — Shadow A/B entrée pullback + SL élargi (variante non-tradée).
--
-- Contexte (analyse 20/05/2026) : le scanner gainers live entre en momentum-chase
-- (au sommet du pump) avec SL serré (~1.5%). Backtest crypto 48h + V1 shadow equity
-- (83 trades, WR 34.9%, -3.87%/trade malgré SL 4.84%) montrent que :
--   - momentum-chase => espérance NÉGATIVE (-0.29%/trade)
--   - pullback-dans-tendance + SL adapté => espérance POSITIVE (+0.47%/trade net)
-- L'edge vient de l'ENTRÉE (et de la géométrie d'exit), pas de la largeur d'univers.
--
-- Cette migration ajoute des colonnes pour shadow-simuler EN PARALLÈLE du live,
-- sur les mêmes signaux ACCEPT, une variante d'entrée :
--   - on attend un pullback de `pullback_pct` sous le prix signal dans une fenêtre
--   - si touché : entrée à ce prix avec SL `sl_pct` (élargi) + TP `tp_pct`
--   - si jamais touché dans la fenêtre : `variant_no_entry=true` (on rate, réaliste)
-- Le moteur de trailing BLOC4 (applyTick) est strictement identique au live :
-- seuls le prix d'entrée et la distance SL changent → isolation propre de l'effet.
--
-- ZÉRO risque capital : colonnes additives, aucune position réelle n'est ouverte.
-- Remplies post-hoc par ShadowExitSimulatorService.runVariantInner (cron 5 min).

ALTER TABLE public.gainers_v1_shadow_signals
  ADD COLUMN IF NOT EXISTS variant_entry_price      NUMERIC(18,8),
  ADD COLUMN IF NOT EXISTS variant_entry_offset_min INT,
  ADD COLUMN IF NOT EXISTS variant_no_entry         BOOLEAN,
  ADD COLUMN IF NOT EXISTS variant_exit_price       NUMERIC(18,8),
  ADD COLUMN IF NOT EXISTS variant_exit_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS variant_exit_reason      TEXT,
  ADD COLUMN IF NOT EXISTS variant_pnl_pct          NUMERIC(8,5),
  ADD COLUMN IF NOT EXISTS variant_slippage_pct     NUMERIC(7,5),
  ADD COLUMN IF NOT EXISTS variant_params           JSONB;

-- Index pour le worker : signaux ACCEPT dont la variante n'est pas encore tranchée
-- (ni entrée résolue, ni no_entry). Partiel pour rester léger.
CREATE INDEX IF NOT EXISTS gainers_v1_shadow_signals_variant_pending_idx
  ON public.gainers_v1_shadow_signals (created_at ASC)
  WHERE decision = 'ACCEPT'
    AND entry_price IS NOT NULL
    AND variant_exit_at IS NULL
    AND variant_no_entry IS NULL;

COMMENT ON COLUMN public.gainers_v1_shadow_signals.variant_entry_price IS
  'Shadow A/B — prix d''entrée pullback (close ayant touché entry_price*(1-pullback_pct)).';
COMMENT ON COLUMN public.gainers_v1_shadow_signals.variant_no_entry IS
  'Shadow A/B — true si aucun pullback dans la fenêtre (la variante n''aurait pas tradé).';
COMMENT ON COLUMN public.gainers_v1_shadow_signals.variant_params IS
  'Shadow A/B — {pullback_pct, window_min, sl_pct, tp_pct} utilisés (reproductibilité).';
