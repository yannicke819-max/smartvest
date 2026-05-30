-- 0174 — LISA reset markers (display-only, jamais effacement DB)
--
-- Permet à l'utilisateur de "reset" l'affichage des compteurs jour/mois/an
-- SANS jamais effacer les positions en DB. Le marker est un timestamp à partir
-- duquel le compteur affiché ignore les trades antérieurs.
--
-- Use case : si l'utilisateur a eu une journée catastrophique et veut "repartir
-- à zéro psychologiquement", il reset le marker jour à NOW. Les trades de la
-- matinée restent en DB (audit, P&L global réel intact), mais l'UI affiche
-- "Jour : +$0" jusqu'à la fin de la journée.
--
-- Reset annuel reset aussi mois + jour (cascade). Reset mois reset aussi jour.
-- Reset jour ne reset rien d'autre.

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS lisa_reset_marker_daily timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lisa_reset_marker_monthly timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lisa_reset_marker_annual timestamptz DEFAULT NULL;

COMMENT ON COLUMN public.lisa_session_configs.lisa_reset_marker_daily IS
'Si non-null, le compteur jour affiché ignore les trades avec exit_timestamp < marker. Reset display-only, DB intacte.';

COMMENT ON COLUMN public.lisa_session_configs.lisa_reset_marker_monthly IS
'Idem reset marker mois. Annulable par UPDATE NULL.';

COMMENT ON COLUMN public.lisa_session_configs.lisa_reset_marker_annual IS
'Idem reset marker année. Action irréversible côté UI (modal "tape RESET pour confirmer").';
