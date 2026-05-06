-- 0121_gainers_rotation_stagnant_age
--
-- PR #262 — User configurable threshold pour Capital Rotation Gate (PR #261).
-- Le seuil "stagnante depuis ≥ N min" était hardcodé à 90 min. Le user
-- demande un slider UI pour ajuster.
--
-- Range : 15 min minimum (évite whipsaw extrême) à 480 min (8h, full Asia
-- session) maximum.

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_rotation_stagnant_min_age_min INT
  DEFAULT 90
  CHECK (gainers_rotation_stagnant_min_age_min IS NULL OR
         (gainers_rotation_stagnant_min_age_min >= 15 AND gainers_rotation_stagnant_min_age_min <= 480));

COMMENT ON COLUMN public.lisa_session_configs.gainers_rotation_stagnant_min_age_min IS
  'PR #262 — Capital Rotation Gate : durée minimale (en minutes) avant qu''une position '
  'soit considérée stagnante et candidate à la rotation. Range 15-480 min, default 90.';
