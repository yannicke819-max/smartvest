-- P3-C — Cache des bougies daily OHLCV pour le scanner rebound-tp.
--
-- Objectif : éviter de re-fetcher 500 tickers × 26 ticks/jour = 13 000
-- requêtes EODHD/jour. Le cron quotidien `OhlcvCacheService` (21:30 UTC,
-- post-close NYSE) UPSERT les nouvelles bougies. Le scanner lit le cache
-- en phase 1 (pre-filter RSI) puis ne fetch en temps réel que les
-- candidats de phase 2 (~30-50 tickers/tick au lieu de 500).
--
-- Capacity check : 500 tickers × 60 bars × ~50 bytes = 1.5 MB. Index
-- composite (ticker, bar_date DESC) supporte les query "60 dernières
-- bougies par ticker" en O(log n).

CREATE TABLE IF NOT EXISTS public.ohlcv_cache_daily (
  ticker text NOT NULL,
  bar_date date NOT NULL,
  open numeric(18, 6) NOT NULL CHECK (open > 0),
  high numeric(18, 6) NOT NULL CHECK (high > 0),
  low numeric(18, 6) NOT NULL CHECK (low > 0),
  close numeric(18, 6) NOT NULL CHECK (close > 0),
  volume bigint NOT NULL CHECK (volume >= 0),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ohlcv_cache_daily_pkey PRIMARY KEY (ticker, bar_date),
  CONSTRAINT ohlcv_cache_daily_high_ge_low CHECK (high >= low)
);

-- Index pour la query principale (60 dernières bougies par ticker).
CREATE INDEX IF NOT EXISTS ohlcv_cache_daily_ticker_date_desc_idx
  ON public.ohlcv_cache_daily (ticker, bar_date DESC);

-- RLS : service_role uniquement. Les users finaux n'ont pas vocation
-- à lire les bougies brutes (la donnée macro est dérivée pour eux via
-- LisaService). Le scanner backend utilise service_role qui bypasse RLS.
ALTER TABLE public.ohlcv_cache_daily ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ohlcv_cache_daily'
      AND policyname = 'ohlcv_cache_daily_service_role_only'
  ) THEN
    -- Policy explicite qui rejette tout (l'absence de policy bloque déjà
    -- via RLS, mais on tag explicitement le pattern pour audit).
    CREATE POLICY ohlcv_cache_daily_service_role_only ON public.ohlcv_cache_daily
      FOR SELECT
      USING (false);
  END IF;
END $$;

COMMENT ON TABLE public.ohlcv_cache_daily IS
  'P3-C — cache des bougies daily OHLCV pour scanner rebound-tp. UPSERT par OhlcvCacheService cron 21:30 UTC. Lecture par phase 1 du scanner (RSI pre-filter sur 500 tickers).';
