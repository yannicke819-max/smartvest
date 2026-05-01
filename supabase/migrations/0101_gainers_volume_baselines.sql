-- 0101 — ADR-005 BLOC 2 : table gainers_volume_baselines
--
-- Stocke la médiane du volume dollar sur 20 jours de trading par symbole/exchange.
-- Utilisée par deux gates :
--   - BLOC 1 liquidity floor (medianDailyVolUsd20d)
--   - BLOC 2 RVOL intraday cumulatif (vol_open→now / avg_same_window_20d)
--
-- Alimentée par cron quotidien VolumeBaselineService.refreshAll() à 01:00 UTC.
-- Rétention : sans limite (upsert sur (symbol, exchange)).

CREATE TABLE IF NOT EXISTS public.gainers_volume_baselines (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol                TEXT        NOT NULL,
  exchange              TEXT        NOT NULL,
  asset_class           TEXT        NOT NULL CHECK (asset_class IN ('equity', 'crypto')),
  window_days           INTEGER     NOT NULL DEFAULT 20,
  median_dollar_volume  NUMERIC(22, 2) NOT NULL,
  last_nonzero_at       TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT gainers_volume_baselines_symbol_exchange_unique UNIQUE (symbol, exchange)
);

CREATE INDEX IF NOT EXISTS gainers_volume_baselines_symbol_idx
  ON public.gainers_volume_baselines (symbol, exchange);

COMMENT ON TABLE public.gainers_volume_baselines IS
  'Médiane du volume dollar sur 20 jours de trading par symbole/exchange. '
  'ADR-005 BLOC 2 (PR3). Cron daily 01:00 UTC via VolumeBaselineService.';

COMMENT ON COLUMN public.gainers_volume_baselines.median_dollar_volume IS
  'Médiane(daily_dollar_volume) sur window_days derniers jours de trading. '
  'Equity : close × volume EODHD EOD. Crypto : VWAP × vol Binance klines.';

COMMENT ON COLUMN public.gainers_volume_baselines.last_nonzero_at IS
  'Dernier jour où le volume dollar était > 0. NULL si jamais vu.';
