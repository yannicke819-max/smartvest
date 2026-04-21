-- 0011_sniper_mode.sql
-- Personal sniper mode — minimal, opt-in, code-unlockable override
--
-- One table. A session row is inserted on successful unlock and left in
-- place forever — the row IS the audit trail. Terminal status (expired /
-- revoked) is derived from the status column + timestamps; there is no
-- separate events table.

create table if not exists public.sniper_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,

  status text not null
    check (status in ('unlocked','expired','revoked')),

  unlock_method text not null default 'local_code'
    check (unlock_method in ('local_code')),

  unlocked_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,

  ttl_minutes integer not null default 15 check (ttl_minutes between 1 and 240),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sniper_sessions_user_idx
  on public.sniper_sessions(user_id, unlocked_at desc);

-- Only one "unlocked" session per user at a time.
create unique index if not exists sniper_sessions_one_unlocked_per_user
  on public.sniper_sessions(user_id)
  where status = 'unlocked';

alter table public.sniper_sessions enable row level security;

create policy "sniper_sessions_owner_select" on public.sniper_sessions
  for select using (auth.uid() = user_id);

create policy "sniper_sessions_owner_modify" on public.sniper_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
