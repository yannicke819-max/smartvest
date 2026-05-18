-- PR #351 — Scoring discriminant continu [0..100]
--
-- Ajoute :
--   1. continuous_score_floor par classe dans asset_class_tpsl_config
--      (seuils calibrés sur 14j data : asia=65, eu=70, us_large=60, us_sm=65, crypto=55)
--   2. Sub-scores logging dans top_gainers_log (5 sous-scores + total)
--   3. Index sur continuous_score_total pour requêtes audit / backtest

BEGIN;

-- 1. Seuil continu par classe
ALTER TABLE asset_class_tpsl_config
  ADD COLUMN IF NOT EXISTS continuous_score_floor INT DEFAULT 60;

UPDATE asset_class_tpsl_config SET continuous_score_floor = 65 WHERE asset_class = 'asia_equity';
UPDATE asset_class_tpsl_config SET continuous_score_floor = 70 WHERE asset_class = 'eu_equity';
UPDATE asset_class_tpsl_config SET continuous_score_floor = 60 WHERE asset_class = 'us_equity_large';
UPDATE asset_class_tpsl_config SET continuous_score_floor = 65 WHERE asset_class = 'us_equity_small_mid';
UPDATE asset_class_tpsl_config SET continuous_score_floor = 55 WHERE asset_class = 'crypto_major';

-- 2. Sub-scores dans top_gainers_log
ALTER TABLE top_gainers_log
  ADD COLUMN IF NOT EXISTS sub_amplitude_score NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS sub_rvol_score NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS sub_momentum_score NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS sub_persistence_score NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS sub_cap_quality_score NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS continuous_score_total NUMERIC(5,2);

-- 3. Index pour requêtes backtest et audit (filtre + tri sur score)
CREATE INDEX IF NOT EXISTS idx_top_gainers_log_continuous_score
  ON top_gainers_log (continuous_score_total DESC NULLS LAST, captured_at DESC);

COMMENT ON COLUMN asset_class_tpsl_config.continuous_score_floor IS
  'PR #351 — seuil de décision sur le score continu [0..100]. Si CONTINUOUS_SCORING_ENABLED=true, un candidat est accepté si scoreResult.total >= continuous_score_floor.';

COMMENT ON COLUMN top_gainers_log.continuous_score_total IS
  'PR #351 — score continu [0..100] agrégeant amplitude/rvol/momentum/persistence/capQuality. Loggué même si flag OFF pour backtest comparatif.';

COMMIT;
