-- 0198 — Raison du manual_control, pour ne ré-armer le SL auto QUE sur échec LLM.
--
-- Affinage du filet 20min (0196) suite à l'intention user (07/06) : "re-arm
-- seulement s'il y a un problème avec le LLM, sinon on laisse en Manu".
--
-- Valeurs :
--   'llm_unresolved'  → DANGER_ZONE a mis manual_control mais le LLM n'a pas
--                       résolu (Mistral down/muet/hung/unavailable). → RE-ARM éligible.
--   'llm_wait_user'   → le LLM a répondu et a délibérément choisi wait_user
--                       (il fonctionne, il défère à l'humain). → PAS de re-arm.
--   'user_manual'     → l'utilisateur a pris la main via le toggle UI. → PAS de re-arm.
--   NULL              → inconnu / legacy. → PAS de re-arm (conservateur).
--
-- Le cron ne ré-arme QUE si manual_control_reason = 'llm_unresolved'.
ALTER TABLE lisa_positions
  ADD COLUMN IF NOT EXISTS manual_control_reason TEXT;
