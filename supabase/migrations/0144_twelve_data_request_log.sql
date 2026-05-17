-- 0144 — PR #342 : log des appels TwelveData (POC weekend)
--
-- Trace toutes les requêtes vers l'API TwelveData (Basic 800/jour, 8/min) pour
-- monitoring quota + debug. Pattern identique à eodhd_request_log : insert
-- append-only par le service `TwelveDataService.logCall`, lecture via dashboards
-- ops / cron alerting.
--
-- called_by : permet d'attribuer le call à un consumer ('supertrend_us_large',
-- 'rsi_crypto_overbought', 'manual_admin', ...) pour cost attribution.

CREATE TABLE IF NOT EXISTS twelve_data_request_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  endpoint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  interval TEXT,
  status_code INT,
  success BOOLEAN NOT NULL DEFAULT FALSE,
  credits_used INT NOT NULL DEFAULT 1,
  latency_ms INT,
  error_message TEXT,
  called_by TEXT NOT NULL DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_twelve_data_request_log_timestamp
  ON twelve_data_request_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_twelve_data_request_log_symbol
  ON twelve_data_request_log(symbol);
CREATE INDEX IF NOT EXISTS idx_twelve_data_request_log_called_by
  ON twelve_data_request_log(called_by, timestamp DESC);

COMMENT ON TABLE twelve_data_request_log IS
  'PR #342 POC — trace append-only des appels TwelveData (Basic 800/jour).';
COMMENT ON COLUMN twelve_data_request_log.credits_used IS
  'Coût en credits TwelveData (1 par endpoint indicator, 0 pour /api_usage).';
COMMENT ON COLUMN twelve_data_request_log.called_by IS
  'Identifiant du consumer pour cost attribution (supertrend_us_large, rsi_crypto_overbought, manual_admin).';
