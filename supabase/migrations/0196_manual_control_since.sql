-- 0196 — Filet "machine si user absent" pour le DANGER_ZONE / manual_control.
--
-- Contexte (07/06/2026) : quand une position atteint X% du chemin vers son SL,
-- le DANGER_ZONE met manual_control=true et BLOQUE tout stop auto (checkStopTarget
-- early-return), en attendant une décision LLM/user. Si le LLM reste muet
-- (wait_user, ou Mistral down — bug clé révoquée du 07/06) et que l'user est
-- absent, la position saigne SANS AUCUN stop (incident prouvé : GNFT.PA -5.56%
-- sur un SL -1.5%, BME.LSE -2.43%, toutes manual_control=true).
--
-- Ce timestamp enregistre QUAND manual_control est passé à true. Le cron
-- mécanique ré-arme le SL auto (manual_control=false) après
-- MANUAL_CONTROL_REARM_MIN minutes (default 20) sans résolution — sauf oversold
-- (hold overnight extended volontaire, géré par OversoldExitService).
ALTER TABLE lisa_positions
  ADD COLUMN IF NOT EXISTS manual_control_since TIMESTAMPTZ;
