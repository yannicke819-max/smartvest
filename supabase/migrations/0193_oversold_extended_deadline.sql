-- 0193_oversold_extended_deadline.sql
-- Mode "OVERSOLD EXTENDED" : positions oversold US qui dépassent un seuil de
-- perte à la fenêtre de force-close 20:45 UTC sont mises en mode "extended"
-- avec une deadline J+10 pour tenter de récupérer breakeven.
--
-- Si `extended_deadline_at` IS NOT NULL → position en mode extended :
--   - Mechanical cron skip standard SL/TP
--   - Recovery monitor cherche fenêtre de close (breakeven, vélocité positive, deadline)
--
-- Cohabite avec `manual_control` (PR #614 DANGER_ZONE_LLM peut aussi avoir
-- activé manual_control auparavant).

ALTER TABLE lisa_positions
  ADD COLUMN IF NOT EXISTS extended_deadline_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS extended_entered_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN lisa_positions.extended_deadline_at IS 'Si non-null, position en mode OVERSOLD_EXTENDED jusqu''à cette date (J+10). Recovery monitor cherche window de close.';
COMMENT ON COLUMN lisa_positions.extended_entered_at IS 'Timestamp d''entrée en mode extended (= 20:45 UTC du jour où la position a dépassé le seuil de perte).';

CREATE INDEX IF NOT EXISTS idx_lisa_positions_extended_open
  ON lisa_positions (extended_deadline_at)
  WHERE extended_deadline_at IS NOT NULL AND status = 'open';
