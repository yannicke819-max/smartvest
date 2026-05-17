-- 0145 — PR #344 P1 : enrichit eodhd_request_log avec endpoint + extras (JSONB)
--
-- Préparation pour l'instrumentation 100 % des appels EODHD (gap 78 % du
-- quota actuellement invisible dans le log). P1 = screener uniquement
-- (probable gros consommateur d'après l'audit 17/05).
--
-- - endpoint : 'screener', 'eod', 'real-time', 'intraday', 'technical', etc.
--   Sépare l'attribution par endpoint indépendamment du called_by (qui est
--   l'identifiant du consumer).
-- - extras   : JSONB libre pour métadonnées spécifiques (n_symbols_returned
--   sur screener pour estimer les crédits réels = 5 + N, page/offset, cache_hit,
--   credits_estimes par appel, etc.).

ALTER TABLE eodhd_request_log
  ADD COLUMN IF NOT EXISTS endpoint TEXT,
  ADD COLUMN IF NOT EXISTS extras JSONB;

COMMENT ON COLUMN eodhd_request_log.endpoint IS
  'PR #344 — URL endpoint EODHD relatif (screener, eod, real-time, technical, etc.).';
COMMENT ON COLUMN eodhd_request_log.extras IS
  'PR #344 — métadonnées libres JSONB (n_symbols_returned, credits_estimes, cache_hit, page, ...).';

CREATE INDEX IF NOT EXISTS idx_eodhd_req_log_endpoint
  ON eodhd_request_log(endpoint, timestamp DESC);
