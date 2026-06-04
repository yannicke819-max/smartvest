-- 0191 — Mode OVERSOLD (mean-reversion swing). PR-1 de la spec docs/mode-oversold-spec.md.
--
-- Contexte : 9 backtests prix réels (session 04/06) ont prouvé que le scalp
-- momentum top-gainers n'a PAS d'edge (validé 3-fold, expectancy -0.13%/trade),
-- mais que l'OVERSOLD mean-reversion en a un (validé 3-fold : drop 1J -5/-12%
-- → hold J+10 → alpha +1.4% vs SPY, t=4.1, N=1416).
--
-- Ce nouveau mode est l'INVERSE du gainers : on achète ce qui a CHUTÉ (pas monté),
-- en swing (hold J+10, pas scalp), 1×/jour post-close US (pas 5min).
--
-- Cette migration (additive, idempotente) :
--   1. Étend le CHECK strategy_mode pour accepter 'oversold'
--   2. Ajoute les colonnes de config du mode oversold (avec defaults issus du backtest)
--
-- Aucune row existante n'est modifiée. Le mode reste inactif tant qu'aucun
-- portfolio n'a strategy_mode='oversold' (recyclage HIGH = PR-6).

-- ─── Étape 1 : étendre le CHECK strategy_mode ───────────────────────────────
-- DROP + recreate (le CHECK 0085 ne couvrait que investment/harvest/gainers).
ALTER TABLE public.lisa_session_configs
  DROP CONSTRAINT IF EXISTS lisa_session_configs_strategy_mode_check;

ALTER TABLE public.lisa_session_configs
  ADD CONSTRAINT lisa_session_configs_strategy_mode_check
  CHECK (strategy_mode IN ('investment', 'harvest', 'gainers', 'oversold'));

-- ─── Étape 2 : colonnes de config oversold (defaults = paramètres validés 3-fold) ──
ALTER TABLE public.lisa_session_configs
  -- Borne basse du drop : exclut les falling-knife (<-12% confirmé alpha négatif, N=142)
  ADD COLUMN IF NOT EXISTS oversold_drop_min_pct NUMERIC(5,2) DEFAULT -12.0,
  -- Borne haute du drop : -5% minimum de sur-réaction pour un rebond exploitable
  ADD COLUMN IF NOT EXISTS oversold_drop_max_pct NUMERIC(5,2) DEFAULT -5.0,
  -- Horizon de détention en jours OUVRÉS (J+10 = sweet-spot robuste out-of-sample)
  ADD COLUMN IF NOT EXISTS oversold_hold_days INT DEFAULT 10
    CHECK (oversold_hold_days IS NULL OR (oversold_hold_days >= 1 AND oversold_hold_days <= 60)),
  -- Stop catastrophe LARGE (pas scalp) : coupe une 2e jambe de chute structurelle
  ADD COLUMN IF NOT EXISTS oversold_stop_catastrophe_pct NUMERIC(5,2) DEFAULT -15.0,
  -- Take-profit optionnel (null = pas de TP, hold pur J+10 comme le backtest)
  ADD COLUMN IF NOT EXISTS oversold_tp_pct NUMERIC(5,2) DEFAULT NULL,
  -- Notionnel par position (book diversifié ~150 positions à $1000 sur $150k)
  ADD COLUMN IF NOT EXISTS oversold_position_notional_usd NUMERIC(12,2) DEFAULT 1000.0,
  -- Cap positions simultanées (book diversifié = risk management, contrairement gainers=5)
  ADD COLUMN IF NOT EXISTS oversold_max_open_positions INT DEFAULT 200
    CHECK (oversold_max_open_positions IS NULL OR oversold_max_open_positions >= 1),
  -- Filtre Lisa LLM : chute technique (rebond) vs structurelle (skip — guidance/fraude/downgrade)
  ADD COLUMN IF NOT EXISTS oversold_lisa_catalyst_filter BOOLEAN DEFAULT true,
  -- Univers watchlist (nom dans watchlist_universe ; default = russell1000 à peupler)
  ADD COLUMN IF NOT EXISTS oversold_universe TEXT DEFAULT 'russell1000';

-- ─── Bornes de cohérence (drop_min < drop_max, tous deux négatifs) ──────────
-- On NE met PAS de CHECK croisé drop_min < drop_max ici (Postgres CHECK ne
-- référence pas facilement 2 colonnes avec defaults au moment de l'ALTER sur
-- rows existantes) — la validation est faite côté service au runtime.

-- ─── Index partiel pour le scan oversold (cohérent avec l'index gainers 0085) ──
CREATE INDEX IF NOT EXISTS lisa_session_configs_oversold_idx
  ON public.lisa_session_configs (portfolio_id)
  WHERE strategy_mode = 'oversold';

COMMENT ON COLUMN public.lisa_session_configs.oversold_drop_min_pct IS
  '0191 — Borne basse drop 1J (default -12% : exclut falling-knife, alpha négatif confirmé 3-fold).';
COMMENT ON COLUMN public.lisa_session_configs.oversold_hold_days IS
  '0191 — Horizon détention jours ouvrés (default 10 = sweet-spot validé out-of-sample, J+5 fragile).';
