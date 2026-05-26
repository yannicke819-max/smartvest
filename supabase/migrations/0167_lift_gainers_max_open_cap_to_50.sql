-- Migration 0167 — Lift gainers_max_open_positions cap from 20 to 50.
-- Nécessaire pour profile "small" du shadow sizing (40 positions × $262).
-- Réversible : ALTER TABLE drop puis re-add avec ancien check.

ALTER TABLE public.lisa_session_configs
  DROP CONSTRAINT IF EXISTS lisa_session_configs_gainers_max_open_positions_check;

ALTER TABLE public.lisa_session_configs
  ADD CONSTRAINT lisa_session_configs_gainers_max_open_positions_check
  CHECK (gainers_max_open_positions IS NULL OR (gainers_max_open_positions BETWEEN 1 AND 50));

COMMENT ON CONSTRAINT lisa_session_configs_gainers_max_open_positions_check
  ON public.lisa_session_configs
  IS 'Lifted from 20 to 50 (migration 0167) to support shadow_small profile (40 pos).';
