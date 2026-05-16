-- 0140 — Phase 5 N1 PR-1 : table d'observabilité des Quick Wins (Règle E)
--
-- Chaque QW (#1, #6, #11, #17, #18) écrit une ligne à chaque décision
-- (pass / block / modify) pour permettre la mesure J+5 :
--   - combien de signaux par QW
--   - shadow impact (`would_have_passed_without_flag`) pour chiffrer le gate
--   - audit a posteriori des blocages (debug régressions)
--
-- Pas de FK vers lisa_positions : un block ne crée pas de position, donc
-- pas de position_id à référencer. Le couple (symbol, created_at) suffit
-- pour rejoindre lisa_positions si le signal est passé.

CREATE TABLE IF NOT EXISTS qw_decision_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  qw_id text NOT NULL,
  symbol text NOT NULL,
  asset_class text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('pass', 'block', 'modify')),
  reason text NOT NULL,
  would_have_passed_without_flag boolean NOT NULL DEFAULT false,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_qw_decision_log_created_at
  ON qw_decision_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_qw_decision_log_qw_id_created_at
  ON qw_decision_log (qw_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_qw_decision_log_symbol_created_at
  ON qw_decision_log (symbol, created_at DESC);

COMMENT ON TABLE qw_decision_log IS
  'Phase 5 N1 PR-1 — log append-only des décisions des Quick Wins (Règle E observabilité).';
COMMENT ON COLUMN qw_decision_log.qw_id IS
  'QW_1 | QW_6 | QW_11 | QW_17 | QW_18';
COMMENT ON COLUMN qw_decision_log.decision IS
  'pass : laisser passer ; block : empêcher ouverture ; modify : ajuster sizing';
COMMENT ON COLUMN qw_decision_log.would_have_passed_without_flag IS
  'True si le signal aurait été accepté sans ce QW — sert à chiffrer le shadow impact J+5.';
