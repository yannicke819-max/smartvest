-- Option "Tourner uniquement pendant les heures de marché" pour l'autopilot.
-- Quand activé, les cycles autopilot sont skippés hors fenêtre 07:00-20:00 UTC
-- (couvre pré-marché Euronext 09:00 CET → clôture NYSE 21:00 CET / 20:00 UTC).
-- Crypto est 24/7 mais les catalyseurs majeurs (news macro, earnings) se
-- concentrent sur cette fenêtre.

alter table lisa_session_configs
  add column if not exists autopilot_market_hours_only boolean not null default false;

comment on column lisa_session_configs.autopilot_market_hours_only is
  'Si true, autopilot cycles skippés hors fenêtre 07:00-20:00 UTC (heures de marché EU+US). Économie ~45% de coût Claude sur 24/7.';
