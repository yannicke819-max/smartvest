-- Migration 0111 — PR6.8 RCFT (Rejected-Candidate Forward Tracking).
--
-- Suit ce que devient un signal V1 (ACCEPT ou REJECT) à T+24h et T+72h.
-- Permet à AutoTuner (Phase C) de mesurer FP-rate par gate :
--   - REJECT + return_72h > +5% → 'champion' (gate trop strict)
--   - ACCEPT + return_72h < -2% → 'failure' (gate trop laxiste)
--
-- Symétrie ACCEPT/REJECT pour signal balanced à AutoTuner.
-- Cloisonnement env_tag pour ne pas mélanger shadow/canary/prod en agrégat.
--
-- Idempotente : CREATE IF NOT EXISTS pour table + indexes.

CREATE TABLE IF NOT EXISTS gainers_signal_forward (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shadow_signal_id         UUID REFERENCES gainers_v1_shadow_signals(id) ON DELETE SET NULL,

  -- Identité du signal
  symbol                   TEXT NOT NULL,
  asset_class              TEXT NOT NULL,
  decision                 TEXT NOT NULL,    -- 'ACCEPT' | 'REJECT'
  reject_reason            TEXT,             -- nullable pour ACCEPT

  -- Diagnostic gates (PR6.8 ajout 3) : last gate franchi avant rejet
  -- 'liquidity' | 'marketCap' | 'volatility' | 'persistence' | 'trend' | 'spread' | 'all'
  -- 'all' = ACCEPT (passé tous les gates)
  -- null = REJECT au 1er gate (LIQUIDITY_FLOOR)
  gate_passed_until        TEXT,

  -- Cloisonnement environnement (PR6.8 ajout 4)
  -- shadow = pre-Phase 4
  -- canary = Phase 4 canary 10%
  -- prod = Phase 4 full deploy
  env_tag                  TEXT NOT NULL DEFAULT 'shadow',

  -- Timing + prix
  rejected_at              TIMESTAMPTZ NOT NULL,
  price_at_signal          NUMERIC NOT NULL,

  -- Forward prices (nullable jusqu'à fetch cron)
  price_t_plus_24h         NUMERIC,
  price_t_plus_72h         NUMERIC,
  return_24h               NUMERIC,          -- (price_t+24h - price_at_signal) / price_at_signal
  return_72h               NUMERIC,

  -- Outcome (PR6.8 ajout 5 — symétrie)
  -- 'champion' = REJECT + return_72h > +champion_threshold_pct (gate trop strict)
  -- 'failure'  = ACCEPT + return_72h < failure_threshold_pct (gate trop laxiste)
  -- 'neutral'  = ni champion ni failure
  -- null       = pas encore évalué (T+72h pas encore atteint)
  outcome                  TEXT,
  champion_threshold_pct   NUMERIC NOT NULL DEFAULT 0.05,    -- 5% figé (anti data-leakage)
  failure_threshold_pct    NUMERIC NOT NULL DEFAULT -0.02,   -- -2% figé

  -- Provenance
  source                   TEXT NOT NULL,    -- 'binance' | 'eodhd'
  fetched_24h_at           TIMESTAMPTZ,
  fetched_72h_at           TIMESTAMPTZ,

  -- TTL (cleanup cron utilise WHERE expires_at < NOW() au DELETE, pas index)
  expires_at               TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT chk_signal_forward_decision CHECK (decision IN ('ACCEPT', 'REJECT')),
  CONSTRAINT chk_signal_forward_env_tag CHECK (env_tag IN ('shadow', 'canary', 'prod')),
  CONSTRAINT chk_signal_forward_outcome CHECK (outcome IS NULL OR outcome IN ('champion', 'failure', 'neutral')),
  CONSTRAINT chk_signal_forward_source CHECK (source IN ('binance', 'eodhd')),
  CONSTRAINT chk_signal_forward_gate CHECK (
    gate_passed_until IS NULL
    OR gate_passed_until IN ('liquidity', 'marketCap', 'volatility', 'persistence', 'trend', 'spread', 'all')
  ),

  -- Une row par (shadow_signal_id) — idempotent upsert
  CONSTRAINT uniq_signal_forward_shadow_id UNIQUE (shadow_signal_id)
);

-- Indexes (sans WHERE temporel pour éviter ERROR 42P17 functions in index predicate must be IMMUTABLE)
CREATE INDEX IF NOT EXISTS idx_signal_forward_decision_reason_env
  ON gainers_signal_forward (decision, reject_reason, env_tag);

CREATE INDEX IF NOT EXISTS idx_signal_forward_rejected_at
  ON gainers_signal_forward (rejected_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_forward_outcome
  ON gainers_signal_forward (outcome) WHERE outcome IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signal_forward_expires_at
  ON gainers_signal_forward (expires_at);

CREATE INDEX IF NOT EXISTS idx_signal_forward_pending_24h
  ON gainers_signal_forward (rejected_at) WHERE price_t_plus_24h IS NULL;

CREATE INDEX IF NOT EXISTS idx_signal_forward_pending_72h
  ON gainers_signal_forward (rejected_at) WHERE price_t_plus_72h IS NULL;

-- RLS service_role only (pas exposé user)
ALTER TABLE gainers_signal_forward ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_signal_forward_full_access" ON gainers_signal_forward;
CREATE POLICY "service_role_signal_forward_full_access"
  ON gainers_signal_forward
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE gainers_signal_forward IS 'PR6.8 RCFT — Rejected-Candidate Forward Tracking. Mesure FP-rate par gate (champion = REJECT-but-rose, failure = ACCEPT-but-fell). Input pour AutoTuner Phase C V2. Cloisonné par env_tag (shadow/canary/prod).';
COMMENT ON COLUMN gainers_signal_forward.outcome IS 'champion|failure|neutral|null. Champion = REJECT + return_72h > 5%. Failure = ACCEPT + return_72h < -2%. Thresholds figés en migration anti data-leakage.';
COMMENT ON COLUMN gainers_signal_forward.gate_passed_until IS 'Dernier gate franchi avant rejet. null = REJECT au 1er gate. all = ACCEPT.';
