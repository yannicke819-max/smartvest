-- P3-D — Migration data : applique les fixes config Lisa sur les rows
-- existantes pour que les nouveaux defaults code (cf. types/index.ts +
-- rebound-scanner.service.ts) ne soient pas masqués par d'anciennes
-- valeurs persistées.
--
-- Idempotente : chaque UPDATE a un WHERE qui filtre sur l'ancienne valeur.
-- Re-running ne fait rien si déjà appliquée.

-- ── Fix 1 : profile hyper_active → active_trading par défaut ─────────
-- Préserve les sessions HARVEST actives (capital_discipline_mode='DAILY_HARVEST')
-- où hyper_active reste légitime (scalping intraday volontaire).
UPDATE public.lisa_session_configs
SET profile = 'active_trading'
WHERE profile = 'hyper_active'
  AND (capital_discipline_mode IS NULL OR capital_discipline_mode != 'DAILY_HARVEST');

-- ── Fix 1 (suite) : autopilot_cycle_minutes 7 → 30 (hors HARVEST) ────
UPDATE public.lisa_session_configs
SET autopilot_cycle_minutes = 30
WHERE autopilot_cycle_minutes <= 7
  AND (capital_discipline_mode IS NULL OR capital_discipline_mode != 'DAILY_HARVEST');

-- ── Fix 2 : maxExposurePerAssetClassPct 28 → 40 ─────────────────────
-- Le default code est déjà 40 ; cette migration ne touche que les
-- rows qui auraient une valeur inférieure persistée (28 historique).
UPDATE public.lisa_session_configs
SET risk_constraints = jsonb_set(
  risk_constraints,
  '{maxExposurePerAssetClassPct}',
  to_jsonb(40.0::numeric)
)
WHERE risk_constraints ? 'maxExposurePerAssetClassPct'
  AND (risk_constraints->>'maxExposurePerAssetClassPct')::numeric < 40;

-- ── Fix 3 : maxOpenPositions > 3 → 3 ─────────────────────────────────
-- Anti-dilution : on cap à 3 même si l'utilisateur a configuré 5/10.
UPDATE public.lisa_session_configs
SET risk_constraints = jsonb_set(
  risk_constraints,
  '{maxOpenPositions}',
  to_jsonb(3::int)
)
WHERE risk_constraints ? 'maxOpenPositions'
  AND (risk_constraints->>'maxOpenPositions')::int > 3;
