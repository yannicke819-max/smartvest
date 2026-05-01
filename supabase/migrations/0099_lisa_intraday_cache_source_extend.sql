-- Extend lisa_intraday_cache.source CHECK constraint to allow 'eodhd_1m'
-- and 'eodhd_ticks' sources introduced by P19v (1m native EODHD fetch) and
-- P19o.3 (tick-aggregated OHLCV fallback).
--
-- Symptom in prod logs: repeated `new row violates check constraint
-- "lisa_intraday_cache_source_che"` for tickers like ARHUF.US, FHRT.
-- The TypeScript type CacheSource was extended but the DB constraint was not.
--
-- Safe: drop + recreate of CHECK constraint, no data migration needed
-- (existing rows already use 'yahoo' / 'eodhd' / 'binance' which remain valid).

ALTER TABLE public.lisa_intraday_cache
  DROP CONSTRAINT IF EXISTS lisa_intraday_cache_source_check;

ALTER TABLE public.lisa_intraday_cache
  ADD CONSTRAINT lisa_intraday_cache_source_check
  CHECK (source IN ('yahoo', 'eodhd', 'eodhd_1m', 'eodhd_ticks', 'binance'));
