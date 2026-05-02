-- 0105 — ADR-007 Target Modes (PR #207a) — extend lisa_session_configs.daily_harvest_config
--
-- Permet de définir n'importe quel objectif monétaire/% sur 4 horizons :
--   ABSOLUTE_USD       : target_value = montant fixe en USD (ex: $100/jour)
--   PCT_OF_EQUITY      : target_value = % du capital courant (ex: 0.5%/jour)
--   MONTHLY_COMPOUND   : monthly_target_pct défini, daily dérivé via (1+m)^(1/21)-1
--   ANNUAL_COMPOUND    : annual_target_pct défini, daily dérivé via (1+y)^(1/252)-1
--
-- Tout est ajouté dans le champ JSONB existant pour zéro impact backward-compat.
-- Seules les nouvelles clés sont lues par TargetDerivationService.

DO $$
DECLARE
  has_column BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'lisa_session_configs'
      AND column_name = 'daily_harvest_config'
  ) INTO has_column;

  IF NOT has_column THEN
    RAISE NOTICE '[0105] daily_harvest_config column missing — skipping (will be re-applied when col present)';
    RETURN;
  END IF;

  -- Backfill default target_mode if not set
  UPDATE public.lisa_session_configs
  SET daily_harvest_config = COALESCE(daily_harvest_config, '{}'::jsonb)
    || jsonb_build_object(
      'target_mode', COALESCE(daily_harvest_config->>'target_mode', 'ABSOLUTE_USD'),
      'target_value', COALESCE((daily_harvest_config->>'target_value')::numeric, 0),
      'monthly_target_pct', COALESCE((daily_harvest_config->>'monthly_target_pct')::numeric, NULL),
      'annual_target_pct', COALESCE((daily_harvest_config->>'annual_target_pct')::numeric, NULL),
      'derived_daily_pct', COALESCE((daily_harvest_config->>'derived_daily_pct')::numeric, NULL)
    )
  WHERE daily_harvest_config IS NOT NULL;

  RAISE NOTICE '[0105] target_mode keys backfilled in lisa_session_configs.daily_harvest_config';
END $$;

COMMENT ON COLUMN public.lisa_session_configs.daily_harvest_config IS
  'JSONB extended (mig 0105 PR #207a) avec : target_mode (ABSOLUTE_USD | PCT_OF_EQUITY | '
  'MONTHLY_COMPOUND | ANNUAL_COMPOUND), target_value, monthly_target_pct, annual_target_pct, '
  'derived_daily_pct (auto-calc compounding géométrique). Cf. ADR-007.';
