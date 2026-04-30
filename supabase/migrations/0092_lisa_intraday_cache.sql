-- P19i — Intraday OHLCV cache pour fallback chain.
--
-- Quand Yahoo (rate-limit IP Fly) ET EODHD (rate-limit / quota) sont KO sur
-- un ticker, on retourne le dernier candles set connu (≤15 min) avec un flag
-- coverage='cache_stale' côté UI (badge dégradé "stale-cache" vs "live").
--
-- Write-on-success : à chaque fetch réussi (yahoo/eodhd/binance), on upsert
-- la série dans cette table. Read-on-fallback : MultiTimeframePersistenceService
-- lit cette table en dernier recours après Yahoo + EODHD.
--
-- TTL applicatif (15 min) — pas de constraint DB, le service filtre par
-- fetched_at à la lecture. Cleanup périodique optionnel (cron Postgres ou
-- side-effect au write si table > N rows).

CREATE TABLE IF NOT EXISTS public.lisa_intraday_cache (
  symbol      TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('yahoo', 'eodhd', 'binance')),
  candles     JSONB NOT NULL,                                  -- Array<{timestamp, open, high, low, close, volume}>
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol)
);

CREATE INDEX IF NOT EXISTS lisa_intraday_cache_fetched_at_idx
  ON public.lisa_intraday_cache (fetched_at DESC);

ALTER TABLE public.lisa_intraday_cache ENABLE ROW LEVEL SECURITY;

-- Service role (API NestJS) full access.
DROP POLICY IF EXISTS "lisa_intraday_cache_service_role" ON public.lisa_intraday_cache;
CREATE POLICY "lisa_intraday_cache_service_role"
  ON public.lisa_intraday_cache
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.lisa_intraday_cache IS
  'P19i — Cache OHLCV intraday derniere fetch reussie par symbole. Lu en fallback quand Yahoo + EODHD sont KO. TTL applicatif 15 min.';
COMMENT ON COLUMN public.lisa_intraday_cache.source IS
  'Provider qui a produit cette serie : yahoo / eodhd / binance';
