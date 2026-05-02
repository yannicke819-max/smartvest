-- 0103 — ADR-005 BLOC 4 : table gainers_positions (state machine TP/SL/trailing)
--
-- Stocke le cycle de vie d'une position ouverte par le scanner Gainers Algo V1.
-- Une ligne par position avec transitions état append-only via gainers_position_events.
--
-- State machine : OPEN → TRAILING_20 → TRAILING_50 → CLOSED
--   - TRAILING_20 : gain ≥ +path_eff → stop = entry + 0.20 × MFE_gain (lock 20% MFE)
--   - TRAILING_50 : gain ≥ +2×path_eff → stop = entry + 0.50 × MFE_gain (lock 50% MFE)
--
-- Sortie :
--   - TP_HIT       : price ≥ tp_price
--   - SL_HIT       : price ≤ stop_price (initial)
--   - TRAILING_20_HIT / TRAILING_50_HIT : price ≤ trailing stop dans l'état correspondant
--   - STRUCTURE_BREAK : price < entry_swing_low post-signal pullback
--   - TIME_LIMIT   : elapsed > time_limit_hours (3h défaut)
--   - INVALIDATION : persistence_lost ou spread_expanded post-entrée

CREATE TABLE IF NOT EXISTS public.gainers_positions (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol          TEXT        NOT NULL,
  exchange        TEXT        NOT NULL,
  asset_class     TEXT        NOT NULL CHECK (asset_class IN ('equity', 'crypto')),

  -- Entry
  trigger_kind        TEXT NOT NULL CHECK (trigger_kind IN ('PULLBACK_HL_FIBO', 'VWAP_RECLAIM')),
  entry_price         NUMERIC(18,8) NOT NULL,
  entry_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  entry_path_eff      NUMERIC(5,4)  NOT NULL CHECK (entry_path_eff >= 0 AND entry_path_eff <= 1),
  entry_swing_low     NUMERIC(18,8),  -- pour STRUCTURE_BREAK detection (PULLBACK_HL_FIBO uniquement)
  entry_vwap          NUMERIC(18,8),  -- snapshot VWAP au moment du signal
  size_usd            NUMERIC(18,2) NOT NULL,

  -- TP/SL initial
  tp_price        NUMERIC(18,8) NOT NULL,
  sl_price        NUMERIC(18,8) NOT NULL,
  tp_pct          NUMERIC(6,5)  NOT NULL,  -- ex: 0.00900 = 0.9%
  sl_pct          NUMERIC(6,5)  NOT NULL,  -- ex: 0.00600 = 0.6%

  -- Trailing state
  state           TEXT NOT NULL CHECK (state IN ('OPEN', 'TRAILING_20', 'TRAILING_50', 'CLOSED')) DEFAULT 'OPEN',
  trailing_stop_price NUMERIC(18,8),  -- null en OPEN, set en TRAILING_*
  mfe_price       NUMERIC(18,8) NOT NULL,  -- max favorable excursion (high water mark)
  mfe_pct         NUMERIC(8,5) NOT NULL DEFAULT 0,  -- (mfe - entry) / entry

  -- Exit
  exit_price      NUMERIC(18,8),
  exit_at         TIMESTAMPTZ,
  exit_reason     TEXT CHECK (exit_reason IN ('TP_FULL', 'SL', 'TRAILING_20_HIT', 'TRAILING_50_HIT', 'STRUCTURE_BREAK', 'TIME_LIMIT', 'INVALIDATION')),
  realized_pnl_usd  NUMERIC(18,2),
  realized_pnl_pct  NUMERIC(8,5),

  -- Audit
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gainers_positions_open_idx
  ON public.gainers_positions (symbol, exchange, state)
  WHERE state IN ('OPEN', 'TRAILING_20', 'TRAILING_50');

CREATE INDEX IF NOT EXISTS gainers_positions_entry_at_idx
  ON public.gainers_positions (entry_at DESC);

-- Append-only event log for state transitions
CREATE TABLE IF NOT EXISTS public.gainers_position_events (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  position_id     UUID        NOT NULL REFERENCES public.gainers_positions(id) ON DELETE CASCADE,
  event_kind      TEXT        NOT NULL CHECK (event_kind IN (
    'OPENED', 'TRAILING_20_TRIGGERED', 'TRAILING_50_TRIGGERED',
    'TP_HIT', 'SL_HIT', 'TRAILING_20_HIT', 'TRAILING_50_HIT',
    'STRUCTURE_BREAK', 'TIME_LIMIT', 'INVALIDATION', 'TICK'
  )),
  price           NUMERIC(18,8) NOT NULL,
  state_before    TEXT,
  state_after     TEXT,
  payload         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gainers_position_events_position_idx
  ON public.gainers_position_events (position_id, created_at DESC);

COMMENT ON TABLE public.gainers_positions IS
  'BLOC 4 ADR-005 — Position state machine OPEN → TRAILING_20 → TRAILING_50 → CLOSED. '
  'TP=path_eff×{1.5 equity / 2.0 crypto}, SL=path_eff×{1.0 equity / 0.8 crypto}. '
  'Lock 20%/50% du MFE en trailing.';

COMMENT ON TABLE public.gainers_position_events IS
  'Audit append-only des transitions de state machine. Une ligne par event (OPENED, TICK, transitions, exit).';
