-- PR-3+PR-4 Phase 5 N1 : régime, score, sessions, sizing différencié, R5 hotfix
--
-- Cette migration ajoute :
--   - lisa_circuit_breaker_state : état du circuit breaker quotidien -$400
--   - lisa_sanity_rejections : audit des fermetures bloquées par R5 sanity
--   - 4 colonnes optionnelles sur asset_class_tpsl_config pour seuils par classe
--
-- Idempotent (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS). Aucun DROP.

CREATE TABLE IF NOT EXISTS lisa_circuit_breaker_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL,
  pnl_at_trigger NUMERIC,
  positions_open_at_trigger INT,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_circuit_breaker_active
  ON lisa_circuit_breaker_state(portfolio_id, triggered_at)
  WHERE resolved_at IS NULL;

ALTER TABLE lisa_circuit_breaker_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'lisa_circuit_breaker_state' AND policyname = 'user_read_own_circuit'
  ) THEN
    CREATE POLICY "user_read_own_circuit" ON lisa_circuit_breaker_state
      FOR SELECT USING (
        portfolio_id IN (SELECT id FROM portfolios WHERE user_id = auth.uid())
      );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS lisa_sanity_rejections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id UUID,
  symbol TEXT NOT NULL,
  asset_class TEXT,
  raw_exit_price NUMERIC,
  raw_pnl_pct NUMERIC,
  raison TEXT NOT NULL,
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_price NUMERIC,
  entry_timestamp TIMESTAMPTZ
);

ALTER TABLE lisa_sanity_rejections ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'lisa_sanity_rejections' AND policyname = 'admin_read_sanity'
  ) THEN
    CREATE POLICY "admin_read_sanity" ON lisa_sanity_rejections
      FOR SELECT USING (auth.role() = 'service_role');
  END IF;
END$$;

ALTER TABLE asset_class_tpsl_config
  ADD COLUMN IF NOT EXISTS warmup_min_override INT,
  ADD COLUMN IF NOT EXISTS regime_filter_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS score_min_floor NUMERIC,
  ADD COLUMN IF NOT EXISTS path_eff_floor NUMERIC;

-- Seeds calibrés data 14-30j SQL réelle (cf BRIEF_PR3_PR4 Phase 5 N1)
UPDATE asset_class_tpsl_config SET path_eff_floor = 0.60 WHERE asset_class IN ('eu_equity','us_equity_large','us_equity_small_mid','crypto_major');
UPDATE asset_class_tpsl_config SET path_eff_floor = 0.30 WHERE asset_class = 'asia_equity';

UPDATE asset_class_tpsl_config SET score_min_floor = 0.95 WHERE asset_class IN ('asia_equity','eu_equity','us_equity_small_mid');
UPDATE asset_class_tpsl_config SET score_min_floor = 0.80 WHERE asset_class = 'us_equity_large';
UPDATE asset_class_tpsl_config SET score_min_floor = 0.65 WHERE asset_class = 'crypto_major';

UPDATE asset_class_tpsl_config SET warmup_min_override = 15 WHERE asset_class = 'asia_equity';
UPDATE asset_class_tpsl_config SET warmup_min_override = 30 WHERE asset_class IN ('eu_equity','us_equity_large','us_equity_small_mid','crypto_major');

UPDATE asset_class_tpsl_config SET regime_filter_enabled = TRUE WHERE asset_class = 'asia_equity';

COMMENT ON TABLE lisa_circuit_breaker_state IS
  'PR-3+PR-4 — état du circuit breaker quotidien (-$400). Auto-reset minuit Paris.';
COMMENT ON TABLE lisa_sanity_rejections IS
  'PR-3+PR-4 — audit append-only des fermetures bloquées par R5 sanity (exit_price≤0, ratio<50%, pnl<-50%).';
