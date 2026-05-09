-- 0138 — Macro veto log table
--
-- PR Action 3 — LLM macro veto pour le scanner gainers.
--
-- Une décision Lisa hourly produit un flag `macro_allowed` global qui
-- gate les opens du scanner. Cette table stocke chaque décision pour :
--   - Audit trail (pourquoi on a skip / let through)
--   - Backtest empirique (validate que le veto évite vraiment les bad days)
--   - UI dashboard (état régime courant)
--
-- Table append-only. La décision la plus récente (max created_at) est la valeur
-- courante du flag. Pas de UPDATE, jamais.

CREATE TABLE IF NOT EXISTS macro_veto_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Décision
  macro_allowed BOOLEAN NOT NULL,
  regime TEXT NOT NULL CHECK (regime IN ('risk_on', 'risk_off', 'transitioning', 'uncertain')),
  veto_reason TEXT,                              -- NULL si macro_allowed=true
  confidence NUMERIC(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  -- Inputs structurés (snapshot indicators au moment de la décision)
  vix NUMERIC(6,2),
  spx_change_pct NUMERIC(5,2),
  dxy NUMERIC(6,2),
  us10y_yield NUMERIC(4,2),

  -- Provenance LLM
  llm_provider TEXT,                             -- 'gemini-flash-lite' | 'claude-opus-4-7' | 'fallback_deterministic'
  llm_cost_usd NUMERIC(8,6),
  llm_latency_ms INT,
  llm_raw_response TEXT,                         -- Stocké pour debugging
  fallback_used BOOLEAN NOT NULL DEFAULT false   -- true si tous les LLM ont fail → règle déterministe
);

CREATE INDEX IF NOT EXISTS macro_veto_log_created_at_idx
  ON macro_veto_log (created_at DESC);

CREATE INDEX IF NOT EXISTS macro_veto_log_recent_decision_idx
  ON macro_veto_log (created_at DESC, macro_allowed);

COMMENT ON TABLE macro_veto_log IS
  'PR Action 3 — Append-only log des décisions LLM macro veto pour le scanner gainers. La décision courante est la row la plus récente. Lecture via getCurrentFlag() qui retourne flag=allow par défaut si table vide ou décision >2h ago (safety).';

COMMENT ON COLUMN macro_veto_log.macro_allowed IS
  'true = scanner peut opener positions normalement. false = veto, scanner skip cycle.';

COMMENT ON COLUMN macro_veto_log.confidence IS
  'Conviction LLM sur la décision [0..1]. Caller peut imposer threshold (ex: ne respect le veto que si confidence > 0.7).';

COMMENT ON COLUMN macro_veto_log.fallback_used IS
  'true quand tous les LLM ont échoué et qu''on a appliqué une règle déterministe (default = allow, fail-open).';
