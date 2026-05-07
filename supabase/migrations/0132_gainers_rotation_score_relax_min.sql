-- 0132_gainers_rotation_score_relax_min
--
-- PR #277 — Relâche le check min_score de [0.5..1.0] à [0..1.0].
-- Score = 0 → désactive le gate (toute rotation autorisée côté score).
-- Permet de rotater des candidats EU dont les scores sont structurellement
-- bas (0.39-0.46 observé) et qui ne pouvaient jamais atteindre 0.5.
--
-- Convention :
--   - NULL → fallback default 0.85 (back-compat)
--   - 0    → gate désactivé (rotation possible peu importe le score)
--   - >0   → seuil min strict
--
-- Drop l'ancien CHECK puis re-add avec la nouvelle range. Idempotent via
-- DO block qui détecte le nom auto-généré du CHECK.

DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'public.lisa_session_configs'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%gainers_rotation_min_score%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.lisa_session_configs DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE public.lisa_session_configs
  DROP CONSTRAINT IF EXISTS gainers_rotation_min_score_range_check;

ALTER TABLE public.lisa_session_configs
  ADD CONSTRAINT gainers_rotation_min_score_range_check
  CHECK (gainers_rotation_min_score IS NULL OR
         (gainers_rotation_min_score >= 0 AND gainers_rotation_min_score <= 1.0));

COMMENT ON COLUMN public.lisa_session_configs.gainers_rotation_min_score IS
  'PR #276/#277 — Seuil score min candidat A+ pour rotation. Range [0..1.0]. '
  '0 = gate désactivé (toute rotation possible). Default 0.85 (vs 0.95 hardcoded ancien).';
