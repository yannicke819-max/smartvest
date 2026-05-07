-- 0126_gainers_post_sl_cooldown
--
-- PR #270 — Post-SL cooldown par symbole.
--
-- Le cooldown global (gainers_cooldown_minutes, default 5min) est trop court
-- pour les symboles qui viennent de se faire stopper. Sur Asia choppy, le
-- pattern observé 07/05/2026 est :
--   00:21 OPEN 000783.SHE @ 8.79
--   00:?? SL  000783.SHE @ 8.66 (-1.60%)
--   00:11 OPEN 000783.SHE @ 8.36 (50min après SL → cooldown 5min déjà passé)
--   00:?? SL  000783.SHE @ 8.23 (-1.65%)
-- = downtrend continu, scanner réouvre sur le mini-rebond technique.
--
-- Solution : cooldown différencié par outcome. Si la dernière position sur
-- ce symbole a fini en `closed_stop`, attendre N min avant de pouvoir
-- réouvrir. Default 60 min (laisse le downtrend épuiser sa pente initiale).

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_post_sl_cooldown_min INT
  DEFAULT 60
  CHECK (gainers_post_sl_cooldown_min IS NULL OR
         (gainers_post_sl_cooldown_min >= 0 AND gainers_post_sl_cooldown_min <= 1440));

COMMENT ON COLUMN public.lisa_session_configs.gainers_post_sl_cooldown_min IS
  'PR #270 — Cooldown additionnel après un closed_stop sur un symbole : '
  'avant qu''il puisse être réouvert. 0 = désactive (cooldown global suffit). '
  'Range [0..1440] min, default 60.';
