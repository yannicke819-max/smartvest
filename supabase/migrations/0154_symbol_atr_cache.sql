-- Phase C — Cache ATR par symbole pour gate volatilité.
--
-- Constat data 15j : 86% des stops EU/Asia small-cap proviennent de tickers
-- dont l'ATR daily > 3%. Skip ces tickers protège le capital.
--
-- Refresh : cron daily 21:30 UTC (après US close) pull EODHD EOD pour
-- l'univers actif (~200 tickers) + crypto majors via Binance.
--
-- Lecture : O(1) côté scanner candidate loop via PRIMARY KEY.

CREATE TABLE IF NOT EXISTS public.symbol_atr_cache (
  symbol            TEXT PRIMARY KEY,
  atr_14d           NUMERIC(16,6) NOT NULL,
  close_at_compute  NUMERIC(16,6) NOT NULL,
  -- (atr / close) × 100. Lecture directe sans recompute côté scanner.
  atr_ratio_pct     NUMERIC(8,4) NOT NULL,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_symbol_atr_cache_computed
  ON public.symbol_atr_cache (computed_at DESC);

ALTER TABLE public.symbol_atr_cache DISABLE ROW LEVEL SECURITY;
