-- 0070_allow_degraded_macro.sql
--
-- PATCH 1 (PR#1 P0) — kill-switch dataQuality côté autopilot.
--
-- Ajoute une colonne booléenne `allow_degraded_macro` à `lisa_session_configs`.
-- Default false : le cycle autopilot est skippé silencieusement quand le
-- snapshot macro est dégradé (us10y + vix en fallback OU 3+ feeds en
-- fallback) pour éviter un appel Claude Opus (~$0.17) sur inputs non fiables.
--
-- L'utilisateur peut outrepasser explicitement via UI (à venir) en mettant
-- ce flag à true — typiquement utile en mode personnel quand on veut Lisa
-- même avec data dégradée pour observer son comportement.
--
-- Audit décisionnel : chaque skip écrit un événement
-- `autopilot_cycle_completed` avec `payload.reason = 'data_quality_degraded'`
-- dans `lisa_decision_log` (cf. lisa-autopilot.service.ts).

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS allow_degraded_macro boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.lisa_session_configs.allow_degraded_macro IS
  'Si true, autorise les cycles autopilot Lisa même si macro snapshot dégradé. Default false (kill-switch actif).';
