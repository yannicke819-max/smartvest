-- 0124_gainers_rotation_stagnant_age_relax_min
--
-- PR #268 — Relâche le min CHECK constraint de 15 à 3 min sur
-- gainers_rotation_stagnant_min_age_min, pour permettre des cycles
-- de rotation très courts (3/5/10 min) sur stratégies scalping ultra-rapides.
--
-- 15 min était une borne conservative anti-whipsaw, mais en mode scalping
-- 1.5% TP / 1% SL, une position qui n'a pas bougé en 3-5 min est déjà
-- "morte" — autant rotater vers un nouveau setup A+.
--
-- Range final : 3-480 min (au lieu de 15-480). Default reste 90 min
-- (pas de migration des valeurs existantes).

ALTER TABLE public.lisa_session_configs
  DROP CONSTRAINT IF EXISTS lisa_session_configs_gainers_rotation_stagnant_min_age_min_check;

-- Le nom auto-généré du CHECK varie selon Postgres ; on tente plusieurs noms
-- pour rester idempotent. La nouvelle constraint a un nom explicite.
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'public.lisa_session_configs'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%gainers_rotation_stagnant_min_age_min%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.lisa_session_configs DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE public.lisa_session_configs
  ADD CONSTRAINT gainers_rotation_stagnant_min_age_min_range_check
  CHECK (gainers_rotation_stagnant_min_age_min IS NULL OR
         (gainers_rotation_stagnant_min_age_min >= 3 AND gainers_rotation_stagnant_min_age_min <= 480));

COMMENT ON COLUMN public.lisa_session_configs.gainers_rotation_stagnant_min_age_min IS
  'PR #262/#268 — Capital Rotation Gate : durée minimale (en minutes) avant qu''une position '
  'soit considérée stagnante et candidate à la rotation. Range 3-480 min, default 90.';
