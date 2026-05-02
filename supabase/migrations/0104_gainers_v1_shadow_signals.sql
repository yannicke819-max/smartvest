-- 0104 — ADR-005 Step 9 : table gainers_v1_shadow_signals
--
-- Shadow run capture chaque signal généré par le pipeline V1 (BLOC 1→2→3→4)
-- AVANT que la bascule live ne soit activée (flag GAINERS_V1_LIVE).
--
-- Critères bascule live (tous requis, ADR-005 §5 Step 9) :
--   1. ≥30 signaux ACCEPT ET ≥20 sessions
--   2. Win-rate ≥45% sur signaux ACCEPT (shadow simulation)
--   3. Divergence legacy ≤20% sur l'overlap
--   4. Zéro erreur critique decision_log
--   5. Snapshot non-régression validé (§4.3)
--
-- Power analysis G*Power : test de proportion deux queues, α=0.05, power=0.90
-- → n_min = 30 trades (Cohen 1988) pour détecter Δ win-rate = +5pp vs aléatoire.

CREATE TABLE IF NOT EXISTS public.gainers_v1_shadow_signals (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  symbol          TEXT        NOT NULL,
  exchange        TEXT        NOT NULL,
  asset_class     TEXT        NOT NULL CHECK (asset_class IN ('equity', 'crypto')),

  -- Decision pipeline V1
  setup_type      TEXT,                -- 'PULLBACK_HL_FIBO' | 'VWAP_RECLAIM' | NULL si REJECT
  composite_score NUMERIC(5,3),
  decision        TEXT        NOT NULL CHECK (decision IN ('ACCEPT', 'REJECT')),
  reject_reason   TEXT,

  -- Entry signal snapshot (si ACCEPT)
  entry_price     NUMERIC(18,8),
  entry_path_eff  NUMERIC(5,4),
  tp_price        NUMERIC(18,8),
  sl_price        NUMERIC(18,8),
  fibo_level      NUMERIC(4,1),       -- 38.2 / 50 / 61.8 / NULL

  -- Diagnostics BLOC 3 (issue #193)
  spread_proxy    NUMERIC(7,5),
  volume_ratio    NUMERIC(8,4),
  session         TEXT,                -- 'RTH' | 'PRE_MARKET' | 'AFTER_HOURS' | 'CRYPTO_24_7' | 'UNKNOWN'

  -- Simulated exit (rempli post-hoc par worker shadow exit-simulator)
  simulated_exit_price  NUMERIC(18,8),
  simulated_exit_at     TIMESTAMPTZ,
  simulated_exit_reason TEXT,         -- 'TP_FULL' | 'SL' | 'TRAILING_20_HIT' | 'TRAILING_50_HIT' | 'STRUCTURE_BREAK' | 'TIME_LIMIT'
  simulated_pnl_pct     NUMERIC(8,5),
  simulated_slippage_pct NUMERIC(7,5),

  -- Legacy comparison (divergence detection)
  legacy_decision        TEXT,        -- décision algo legacy au même instant
  diverges_from_legacy   BOOLEAN GENERATED ALWAYS AS (
    decision IS DISTINCT FROM legacy_decision
  ) STORED
);

-- Index time-series
CREATE INDEX IF NOT EXISTS gainers_v1_shadow_signals_created_idx
  ON public.gainers_v1_shadow_signals (created_at DESC);

-- Index for ACCEPT-only queries (win-rate, profit factor)
CREATE INDEX IF NOT EXISTS gainers_v1_shadow_signals_accept_idx
  ON public.gainers_v1_shadow_signals (decision, created_at DESC)
  WHERE decision = 'ACCEPT';

-- Index for divergence analysis
CREATE INDEX IF NOT EXISTS gainers_v1_shadow_signals_divergence_idx
  ON public.gainers_v1_shadow_signals (diverges_from_legacy)
  WHERE diverges_from_legacy = TRUE;

COMMENT ON TABLE public.gainers_v1_shadow_signals IS
  'ADR-005 Step 9 — shadow run signals avant bascule live. '
  'MAX(20 sessions, 30 signaux ACCEPT) requis pour validation statistique. '
  'Power=0.90, α=0.05, Cohen d=0.3.';

COMMENT ON COLUMN public.gainers_v1_shadow_signals.diverges_from_legacy IS
  'TRUE si decision V1 ≠ decision legacy. Bascule live exige divergence ≤ 20% sur overlap.';
