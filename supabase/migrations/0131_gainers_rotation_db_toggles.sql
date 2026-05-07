-- 0131_gainers_rotation_db_toggles
--
-- PR #276 — Migrer les toggles GAINERS_CAPITAL_ROTATION_ENABLED et
-- GAINERS_HIGH_GRADING_ENABLED de Fly env vars vers DB pour permettre
-- flip via UI (sans Fly CLI).
--
-- Rend aussi configurable le seuil score 0.95 hardcoded de la rotation
-- (était trop strict pour EU mid-morning où peu de candidats atteignent
-- 0.95 → rotation jamais fire).
--
-- Conventions :
--   - Si DB = NULL → fallback sur env var (back-compat)
--   - Si DB = true/false → override env (priorité DB)

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_capital_rotation_enabled BOOLEAN DEFAULT NULL;

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_high_grading_enabled BOOLEAN DEFAULT NULL;

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_rotation_min_score NUMERIC(3,2) DEFAULT 0.85
  CHECK (gainers_rotation_min_score IS NULL OR
         (gainers_rotation_min_score >= 0.5 AND gainers_rotation_min_score <= 1.0));

COMMENT ON COLUMN public.lisa_session_configs.gainers_capital_rotation_enabled IS
  'PR #276 — Toggle DB Capital Rotation. NULL = fallback env GAINERS_CAPITAL_ROTATION_ENABLED. true/false override env.';

COMMENT ON COLUMN public.lisa_session_configs.gainers_high_grading_enabled IS
  'PR #276 — Toggle DB High-Grading mode (rotation sans saturation). NULL = fallback env GAINERS_HIGH_GRADING_ENABLED.';

COMMENT ON COLUMN public.lisa_session_configs.gainers_rotation_min_score IS
  'PR #276 — Seuil score min du candidat A+ pour rotation. Default 0.85 (vs 0.95 hardcoded ancien). Range 0.5-1.0.';
