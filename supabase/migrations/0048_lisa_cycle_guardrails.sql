-- Garde-fous dynamiques pour l'autopilot : cap d'ouvertures par cycle et
-- cooldown post-opening. Les valeurs effectives sont modulées par le
-- `marketMomentum` détecté par Lisa (bullish_strong / neutral / bearish)
-- pour garder la réactivité maximale en fenêtre haussière tout en évitant
-- le churn en régime neutre.
--
-- Valeurs stockées = valeurs "base" (régime neutre). Multiplicateurs
-- appliqués côté back :
--   bullish_strong → cap × 2, cooldown × 0
--   neutral        → cap × 1, cooldown × 1   (valeur saisie)
--   bearish        → cap ÷ 2 (min 1), cooldown × 1.33

alter table lisa_session_configs
  add column if not exists autopilot_max_opens_per_cycle smallint not null default 2,
  add column if not exists autopilot_opening_cooldown_minutes smallint not null default 15;

alter table lisa_session_configs
  add constraint lisa_max_opens_per_cycle_range
    check (autopilot_max_opens_per_cycle between 1 and 7);

alter table lisa_session_configs
  add constraint lisa_opening_cooldown_range
    check (autopilot_opening_cooldown_minutes between 0 and 240);

comment on column lisa_session_configs.autopilot_max_opens_per_cycle is
  'Base : max de nouvelles positions ouvrables dans un cycle. Doublé en bullish_strong, divisé par 2 en bearish.';

comment on column lisa_session_configs.autopilot_opening_cooldown_minutes is
  'Base : minutes à attendre après une ouverture avant qu''un cycle puisse en ouvrir d''autres. Bypass en bullish_strong, ×1.33 en bearish. Fermetures restent toujours autorisées.';

-- Persistance du momentum détecté par Claude sur la proposition.
-- Sert au back à moduler cap + cooldown lors de l'approbation.
alter table lisa_proposals
  add column if not exists market_momentum text not null default 'neutral';

alter table lisa_proposals
  add constraint lisa_proposals_market_momentum_valid
    check (market_momentum in ('bullish_strong', 'neutral', 'bearish'));

comment on column lisa_proposals.market_momentum is
  'Momentum détecté par Lisa : bullish_strong | neutral | bearish. Gouverne les garde-fous serveur à l''approbation.';
