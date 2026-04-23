-- Mutex distribué pour les crons Lisa.
-- Protège contre le multi-run si plusieurs instances Fly tournent en parallèle
-- ou si pg_cron et NestJS se chevauchent.
--
-- Fonctionnement :
--   acquire_cron_lock() → true  : ce process tient le lock, il peut tourner
--   acquire_cron_lock() → false : un autre instance tient le lock, on skip
-- Le lock expire automatiquement après timeout_seconds (défaut 180s) pour
-- gérer les crashs sans libération explicite.

create table if not exists lisa_cron_locks (
  name        text        primary key,
  locked_at   timestamptz not null default now(),
  instance_id text        not null
);

comment on table lisa_cron_locks is
  'Mutex distribué pour les crons Lisa — garantit un seul runner actif à la fois.';

-- Insère ou met à jour le lock si :
--   a) le lock est expiré (> timeout_seconds depuis dernier heartbeat)
--   b) on est déjà le holder (re-entrant safe)
-- Retourne true si on tient le lock après l''appel, false sinon.
create or replace function acquire_cron_lock(
  p_name             text,
  p_instance_id      text,
  p_timeout_seconds  integer default 180
) returns boolean
language plpgsql
security definer
as $$
declare
  v_count integer;
begin
  insert into lisa_cron_locks (name, locked_at, instance_id)
  values (p_name, now(), p_instance_id)
  on conflict (name) do update
    set locked_at   = now(),
        instance_id = p_instance_id
    where
      -- lock expiré (crash ou délai dépassé)
      lisa_cron_locks.locked_at < now() - (p_timeout_seconds || ' seconds')::interval
      -- ou on est déjà le holder (heartbeat / re-entrant)
      or lisa_cron_locks.instance_id = p_instance_id;

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- Seed initial pour chaque type de cron
insert into lisa_cron_locks (name, locked_at, instance_id)
values
  ('autopilot_cycle',    '2000-01-01'::timestamptz, 'init'),
  ('fast_risk_monitor',  '2000-01-01'::timestamptz, 'init'),
  ('price_warmer',       '2000-01-01'::timestamptz, 'init')
on conflict do nothing;
