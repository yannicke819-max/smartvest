-- Patch config sniper — rend le triangle coûts/cycle/capital cohérent.
--
-- Remplacer <USER_ID> par l'UUID utilisateur Supabase Auth avant exécution.
--
-- Effet :
--  - autopilot_cycle_minutes : 5 → 20
--  - Coûts Claude : ~$72/jour → ~$18/jour (aligné avec la cible quotidienne)
--  - Sélectivité Lisa inchangée (anti-consensus, sniper mode, filtres conservés)
--
-- À combiner avec le fix code dans lisa.service.ts (toEodhdTicker : VIX/DXY
-- pointent désormais sur les vrais indices plutôt que VXX.US / UUP.US).

UPDATE lisa_session_configs
SET autopilot_cycle_minutes = 20
WHERE user_id = '<USER_ID>';

-- Vérification :
--   SELECT user_id, profile, autopilot_cycle_minutes, anti_consensus_strength
--   FROM lisa_session_configs
--   WHERE user_id = '<USER_ID>';
