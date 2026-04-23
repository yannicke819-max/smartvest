-- Lisa v2 : Portfolio Trajectory Optimizer
--
-- Ajoute les objectifs de rendement explicites et un budget journalier de
-- coûts à la session config. Ces champs nourrissent le bloc MISSION injecté
-- dans le prompt Claude pour qu'elle raisonne en termes d'écart à la
-- trajectoire cible, pas d'opportunisme pur.
--
-- Tous les targets sont exprimés en % NET de coûts (montants dérivés via
-- capital_usd). NULL = Lisa opère en conviction libre (comportement actuel
-- préservé — pas de régression pour les users qui n'ont pas fixé d'objectifs).

alter table lisa_session_configs
  add column if not exists return_target_daily_pct     numeric(6, 4) null,
  add column if not exists return_target_monthly_pct   numeric(6, 4) null,
  add column if not exists return_target_annual_pct    numeric(6, 4) null,
  add column if not exists daily_cost_budget_usd       numeric(10, 2) null,
  add column if not exists performance_horizon_days    smallint not null default 30;

alter table lisa_session_configs
  add constraint lisa_perf_horizon_range
    check (performance_horizon_days between 7 and 365);

alter table lisa_session_configs
  add constraint lisa_daily_cost_budget_positive
    check (daily_cost_budget_usd is null or daily_cost_budget_usd >= 0);

comment on column lisa_session_configs.return_target_daily_pct is
  'Rendement cible net quotidien en %. NULL = pas d''objectif fixé, Lisa opère sans cible chiffrée.';

comment on column lisa_session_configs.return_target_monthly_pct is
  'Rendement cible net mensuel en %. NULL = pas d''objectif fixé.';

comment on column lisa_session_configs.return_target_annual_pct is
  'Rendement cible net annuel en %. NULL = pas d''objectif fixé.';

comment on column lisa_session_configs.daily_cost_budget_usd is
  'Plafond journalier cumulé des coûts (Claude API + EODHD + trading frictions simulées). Warning seul si dépassé — Lisa ajuste sélectivité, pas de blocage dur.';

comment on column lisa_session_configs.performance_horizon_days is
  'Fenêtre glissante de référence pour mesurer l''écart à la trajectoire cible. 30 j par défaut.';
