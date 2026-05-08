-- 0137_lisa_positions_post_sl_path
--
-- PR #292 — Post-SL path analysis pour identifier wick-stops vs vrais SL.
--
-- Contexte : analyse Kelly du 08/05/2026 montre R-ratio = 1.067 (proche
-- de 1) au lieu du 2.22 théorique (TP 2% / SL 0.9%). Hypothèse : 24% des
-- closed_stop sont des "early exits" RSI/MACD prématurés (PnL -0.1% à
-- -0.7%, bien avant le SL) ET certains stops "réels" sont des wicks
-- (drawdown < 1× ATR puis rebound).
--
-- Cette colonne capture le price action 30min POST-SL pour chaque trade
-- closed_stop, afin de mesurer :
--   - Quel % des SL ont rebondi ≥ 50% du drawdown dans les 30min ?
--   - Quel % était un wick (drawdown < 1× ATR) vs vrai mouvement (>= 2× ATR) ?
--   - SL fixe 0.9% est-il trop serré vs ATR(14) instantané ?
--
-- Schema JSONB :
--   {
--     "exit_price": <number>,
--     "candles_1m": [{ ts, open, high, low, close, volume }, ...] (max 30),
--     "max_drawdown_post_sl_pct": <number>,        -- worst additional loss
--     "max_recovery_post_sl_pct": <number>,        -- best recovery vs exit_price
--     "rebound_to_50pct_within_30min": <bool>,
--     "rebound_to_100pct_within_30min": <bool>,    -- price came back above entry?
--     "atr_14_at_exit_pct": <number>,              -- ATR(14) calc en %
--     "drawdown_in_atr_units": <number>,           -- |drawdown| / atr → < 1 = wick
--     "candle_count": <int>,
--     "fetched_at": <iso timestamp>,
--     "error": <string?>                            -- si refetch a échoué
--   }
--
-- Populated par backfill manuel (endpoint POST /lisa/positions/:id/backfill-post-sl-path)
-- ou par un script one-shot. Pas backfill auto au close (limite EODHD calls).

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS post_sl_path JSONB;

CREATE INDEX IF NOT EXISTS lisa_positions_post_sl_path_pending_idx
  ON public.lisa_positions(exit_timestamp DESC)
  WHERE status = 'closed_stop' AND post_sl_path IS NULL;

COMMENT ON COLUMN public.lisa_positions.post_sl_path IS
  'PR #292 — JSONB avec price action 30min post-SL : candles_1m, max_drawdown_post_sl_pct, '
  'max_recovery_post_sl_pct, rebound_to_50pct_within_30min, atr_14_at_exit_pct, '
  'drawdown_in_atr_units. Permet de distinguer wick-stops (drawdown < 1× ATR) '
  'vs vrais SL. Populated via backfill manuel (endpoint dédié).';
