-- 0125_gainers_rotation_min_path_efficiency
--
-- PR #269 — Rend configurable le seuil pathEff de la Capital Rotation Gate.
--
-- Avant : tryCapitalRotation hardcodé `if (pathEff < 0.5) return skip`.
-- Cela bloque toutes les rotations en mode Asia choppy (pathEff 0.40-0.49)
-- même quand le candidat passe les autres gates (score ≥ 0.95, persistence ≥ 5/6).
--
-- Distinct du gainers_min_path_efficiency global (qui s'applique aux opens
-- normaux). Ce gate est spécifique à la rotation, plus strict par défaut
-- (0.5 vs 0.4 typique sur les opens). Range [0..1] ou NULL pour désactiver.

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_rotation_min_path_efficiency NUMERIC(3,2)
  DEFAULT 0.5
  CHECK (gainers_rotation_min_path_efficiency IS NULL OR
         (gainers_rotation_min_path_efficiency >= 0 AND gainers_rotation_min_path_efficiency <= 1));

COMMENT ON COLUMN public.lisa_session_configs.gainers_rotation_min_path_efficiency IS
  'PR #269 — Capital Rotation Gate : seuil minimum pathEff du candidat A+ pour qu''il '
  'puisse remplacer une position stagnante. NULL = désactive le gate. Range [0..1], default 0.5.';
