-- Mode trading autonome simulation (opt-in, temporaire, jamais permanent).
-- Uniquement applicable aux portefeuilles is_simulation=true (paper broker).
-- Aucun chemin vers une exécution réelle — les colonnes ajoutées ici ne sont
-- lues que par LisaAutopilotService pour auto-approuver ses propres propositions
-- draft. La couche broker reste entièrement simulée.

alter table lisa_session_configs
  add column if not exists autopilot_auto_approve boolean not null default false,
  add column if not exists autopilot_expires_at timestamptz null,
  add column if not exists autopilot_aggressive boolean not null default false;

-- Si auto_approve est activé, expires_at DOIT être défini (contrainte métier,
-- vérifiée côté applicatif car Postgres check constraint ne peut pas
-- dépendre de now()).

comment on column lisa_session_configs.autopilot_auto_approve is
  'Si true ET autopilot_enabled=true ET is_simulation=true ET expires_at>now() : autopilot approuve lui-même ses propositions (paper broker).';
comment on column lisa_session_configs.autopilot_expires_at is
  'Expiration auto du mode auto-approve. Obligatoire si auto_approve=true, max 24h.';
comment on column lisa_session_configs.autopilot_aggressive is
  'Active la persona "chasseur EV+" dans le prompt : turnover élevé, sizing agressif, coupure sèche.';
