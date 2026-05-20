-- PR #366 — Instrumentation comparative TD vs EODHD intraday.
--
-- Objectif : mesurer la VRAIE valeur ajoutée de TwelveData vs EODHD. Le router
-- dual-call (PR #353) appelle les 2 providers en parallèle mais ne garde que TD
-- quand dispo. On ne sait donc pas si TD apporte une donnée différente/plus
-- fraîche qu'EODHD, ou juste de la redondance.
--
-- Cette table loggue, quand les 2 providers réussissent simultanément, le close
-- de la dernière bougie de chaque série + la divergence en bps. Permet en 24h
-- de chiffrer : divergence moyenne, % de cas où TD diffère significativement,
-- distribution par marché.
--
-- Append-only, fire-and-forget côté router (échec insert ne bloque jamais le
-- scanner). Rétention : purge manuelle / cron à prévoir si volume élevé.

CREATE TABLE IF NOT EXISTS intraday_provider_compare (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol TEXT NOT NULL,
  td_symbol TEXT,
  interval TEXT NOT NULL,
  td_close NUMERIC(20,8),
  eodhd_close NUMERIC(20,8),
  -- Divergence relative en basis points : (td - eodhd) / eodhd * 10000.
  -- Positif = TD plus haut qu'EODHD. NULL si eodhd_close <= 0.
  divergence_bps NUMERIC(12,2),
  td_candle_ts BIGINT,    -- timestamp epoch (s) de la dernière bougie TD
  eodhd_candle_ts BIGINT, -- timestamp epoch (s) de la dernière bougie EODHD
  td_candle_count INT,
  eodhd_candle_count INT,
  called_by TEXT NOT NULL DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_intraday_provider_compare_timestamp
  ON intraday_provider_compare(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_intraday_provider_compare_symbol
  ON intraday_provider_compare(symbol, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_intraday_provider_compare_divergence
  ON intraday_provider_compare(ABS(divergence_bps) DESC NULLS LAST, timestamp DESC);

COMMENT ON TABLE intraday_provider_compare IS
  'PR #366 — comparaison close TD vs EODHD quand les 2 réussissent (dual-call). Mesure valeur ajoutée TD.';
COMMENT ON COLUMN intraday_provider_compare.divergence_bps IS
  '(td_close - eodhd_close) / eodhd_close * 10000. Positif = TD plus haut.';
