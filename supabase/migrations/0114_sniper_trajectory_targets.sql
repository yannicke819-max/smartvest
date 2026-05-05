-- Migration 0114 — Sniper trajectory targets (Yaya obligation résultats #3).
--
-- Insère cibles trajectoire dans daily_harvest_config JSONB pour TOUS les
-- portfolios autopilot_enabled (configs actives). Profil Sniper :
--   daily_target_pct  : 0.15% ($15/jour sur $10k)
--   monthly_target_pct: 3.5%  ($350/mois)
--   annual_target_pct : 25%   ($2500/an)
--   profile           : sniper
--   target_mode       : ANNUAL_COMPOUND (cf 0105 target-modes)
--   target_value      : 0.25
--
-- Idempotente : utilise jsonb || pour merge avec config existante (overwrite
-- les keys cibles, préserve le reste).
--
-- Garde-fou : RAISE NOTICE le count de rows touchées pour audit logs.

DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  -- Pre-update count (visibilité utilisateur)
  SELECT COUNT(*) INTO affected_count
  FROM public.lisa_session_configs
  WHERE autopilot_enabled = true;

  RAISE NOTICE '[0114] Sniper targets : % autopilot_enabled rows seront touchées', affected_count;

  -- Apply UPDATE
  UPDATE public.lisa_session_configs
  SET daily_harvest_config = COALESCE(daily_harvest_config, '{}'::jsonb)
    || jsonb_build_object(
      'daily_target_pct', 0.0015,
      'monthly_target_pct', 0.035,
      'annual_target_pct', 0.25,
      'profile', 'sniper',
      'target_mode', 'ANNUAL_COMPOUND',
      'target_value', 0.25
    )
  WHERE autopilot_enabled = true;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE '[0114] Sniper targets : % rows updated', affected_count;
END$$;
