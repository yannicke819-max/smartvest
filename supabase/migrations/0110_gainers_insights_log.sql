-- Migration 0110 — Phase A : insights log structuré pour modèle auto-apprenant.
--
-- Stocke toute observation, divergence, drift, ou proposition d'ajustement
-- (humaine ou automatique) avec payload JSONB pour analyse rétrospective et
-- training de futurs auto-tuners (Phase B/C).
--
-- Append-only : pas de DELETE, status évolue via UPDATE seulement.

CREATE TABLE IF NOT EXISTS gainers_insights_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Catégorie de l'insight (extensible)
  --   'divergence_analysis'  : legacy ACCEPT vs V1 REJECT (ou vice versa)
  --   'cadence_drift'        : ACCEPT/cycle change vs baseline
  --   'reject_pattern'       : reject_reason concentration anormale
  --   'champion_observed'    : symbol récurrent avec near-miss
  --   'threshold_proposal'   : suggestion d'ajustement seuil ADR-005 §1bis
  --   'pipeline_bug'         : bug identifié (ex PR6.6.x trilogy)
  --   'data_quality'         : provider down, fallback, stale data
  --   'ml_refit'             : nouveau modèle P9 fitté avec metrics
  --   'manual_observation'   : observation libre humaine
  insight_type  TEXT NOT NULL,

  -- Origine de l'insight
  --   'manual'                  : opérateur humain via API/UI
  --   'session_chat'            : agent IA (ex Claude Code)
  --   'auto_drift_detector'     : cron Phase B
  --   'auto_threshold_tuner'    : cron Phase C
  --   'auto_ml_refit'           : weekly P9 cron
  --   'auto_anomaly_detector'   : daily report flags
  source        TEXT NOT NULL,

  -- Cycle de vie
  --   'open'         : nouveau, à investiguer
  --   'investigating' : en cours d'analyse
  --   'actioned'     : action prise (PR mergée, threshold ajusté, etc.)
  --   'dismissed'    : faux positif ou non-actionable
  status        TEXT NOT NULL DEFAULT 'open',

  -- Severity (pour dashboard/alertes)
  --   'info'      : observation neutre
  --   'low'       : à examiner sans urgence
  --   'medium'    : nécessite décision sous 7j
  --   'high'      : action requise sous 24h
  --   'critical'  : bug bloquant, hotfix requis
  severity      TEXT NOT NULL DEFAULT 'info',

  -- Résumé human-readable (≤500 chars)
  summary       TEXT NOT NULL,

  -- Données structurées : varie par type
  --   divergence_analysis : { symbol, asset_class, legacy_decision, v1_decision, reject_reason, count }
  --   cadence_drift       : { window_days, accept_count_w1, accept_count_w2, drift_pct }
  --   threshold_proposal  : { threshold_name, current_value, proposed_value, expected_roi, sample_size, auc }
  --   ...
  payload       JSONB NOT NULL,

  -- Contexte additionnel
  -- live SHA, fly_machine_id, etc. au moment de la capture
  context       JSONB,

  -- Résolution (rempli quand status passe à 'actioned' / 'dismissed')
  resolution      TEXT,
  resolution_pr   TEXT,        -- ex 'yannicke819-max/smartvest#221'
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT,        -- email/identifier opérateur

  CONSTRAINT chk_status CHECK (status IN ('open', 'investigating', 'actioned', 'dismissed')),
  CONSTRAINT chk_severity CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical'))
);

-- Index pour queries fréquentes
CREATE INDEX IF NOT EXISTS idx_gainers_insights_type_created ON gainers_insights_log (insight_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gainers_insights_open ON gainers_insights_log (status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_gainers_insights_severity ON gainers_insights_log (severity, created_at DESC) WHERE severity IN ('high', 'critical');

-- RLS : admin-only, jamais exposé user
ALTER TABLE gainers_insights_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_insights_full_access"
  ON gainers_insights_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE gainers_insights_log IS 'Phase A — log structuré pour modèle V1 auto-apprenant. Stocke observations + divergences + drifts + propositions ajustements (human + auto). Append-only.';
