-- Migration 0161 — Cycle scanner gainers → 5 minutes
-- Avant : gainers_cycle_minutes DEFAULT 15 (colonne 0089).
-- Après : 5 min pour toutes les configs existantes + nouveau default.
-- Idempotente : UPDATE ne plante pas si déjà à 5.

ALTER TABLE lisa_session_configs
  ALTER COLUMN gainers_cycle_minutes SET DEFAULT 5;

UPDATE lisa_session_configs
SET gainers_cycle_minutes = 5
WHERE gainers_cycle_minutes IS NULL OR gainers_cycle_minutes != 5;
