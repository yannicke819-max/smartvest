-- 0012_broker_connections.sql
-- Broker Connections module — personal broker integration layer.
--
-- 4 tables + RLS owner-only. Credentials are NEVER stored in-row.
-- Each connection holds a credentials_vault_ref pointing to a secret in the
-- Supabase Vault extension. If the Vault extension is not enabled in the
-- project, credentials_vault_ref stays null and only MANUAL connections work.

create table if not exists public.broker_connections (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null
    check (provider in (
      'INTERACTIVE_BROKERS','SAXO','DEGIRO','TRADING212',
      'BOURSE_DIRECT','FORTUNEO','MANUAL'
    )),
  label text not null,
  status text not null default 'pending'
    check (status in ('pending','active','error','revoked','expired')),

  -- Static per-provider capability flags, denormalised for easy reads.
  supports_read boolean not null default false,
  supports_execution boolean not null default false,
  supports_streaming boolean not null default false,
  supports_options boolean not null default false,
  supports_crypto boolean not null default false,
  supports_csv_import boolean not null default true,

  -- Reference to the secret stored in Supabase Vault. NEVER the secret itself.
  -- Shape: the vault uses uuid ids; we store as text to stay forward-compatible.
  credentials_vault_ref text,

  connected_at timestamptz,
  last_sync_at timestamptz,
  last_error_at timestamptz,
  last_error_message text,

  meta jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists broker_connections_user_idx
  on public.broker_connections(user_id);
create index if not exists broker_connections_status_idx
  on public.broker_connections(status);

alter table public.broker_connections enable row level security;

create policy "broker_connections_owner_select" on public.broker_connections
  for select using (auth.uid() = user_id);
create policy "broker_connections_owner_modify" on public.broker_connections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- broker_accounts — one real account exposed by a connection
-- =========================================================================
create table if not exists public.broker_accounts (
  id uuid primary key default uuid_generate_v4(),
  connection_id uuid not null references public.broker_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  account_id_external text not null,
  account_type text not null default 'other'
    check (account_type in ('cash','margin','pea','pea_pme','tax_sheltered','retirement','other')),
  base_currency char(3) not null default 'EUR',
  display_name text,
  is_active boolean not null default true,

  meta jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (connection_id, account_id_external)
);

create index if not exists broker_accounts_connection_idx
  on public.broker_accounts(connection_id);
create index if not exists broker_accounts_user_idx
  on public.broker_accounts(user_id);

alter table public.broker_accounts enable row level security;

create policy "broker_accounts_owner_select" on public.broker_accounts
  for select using (auth.uid() = user_id);
create policy "broker_accounts_owner_modify" on public.broker_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- broker_sync_jobs — one row per sync attempt
-- =========================================================================
create table if not exists public.broker_sync_jobs (
  id uuid primary key default uuid_generate_v4(),
  connection_id uuid not null references public.broker_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  status text not null default 'pending'
    check (status in ('pending','running','success','partial','failed','cancelled')),

  started_at timestamptz not null default now(),
  finished_at timestamptz,

  positions_count integer not null default 0,
  cash_count integer not null default 0,
  transactions_count integer not null default 0,

  errors jsonb not null default '[]'::jsonb,

  -- Reason for cancellation when applicable (kill-switch, mandate invalid…)
  cancel_reason text,

  created_at timestamptz not null default now()
);

create index if not exists broker_sync_jobs_connection_idx
  on public.broker_sync_jobs(connection_id, started_at desc);
create index if not exists broker_sync_jobs_user_idx
  on public.broker_sync_jobs(user_id, started_at desc);

alter table public.broker_sync_jobs enable row level security;

create policy "broker_sync_jobs_owner_select" on public.broker_sync_jobs
  for select using (auth.uid() = user_id);
create policy "broker_sync_jobs_owner_modify" on public.broker_sync_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- broker_sync_audit_events — hash-chained audit trail
-- =========================================================================
create table if not exists public.broker_sync_audit_events (
  id uuid primary key default uuid_generate_v4(),
  connection_id uuid not null references public.broker_connections(id) on delete cascade,
  sync_job_id uuid references public.broker_sync_jobs(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,

  kind text not null check (kind in (
    'connection_created','connection_updated','connection_revoked',
    'connection_tested_ok','connection_tested_failed',
    'credentials_stored','credentials_rotated','credentials_cleared',
    'sync_started','sync_completed','sync_failed','sync_cancelled',
    'sync_cancelled_by_kill_switch','sync_cancelled_by_mandate'
  )),

  reason text not null,
  payload jsonb,

  hash text not null,
  prev_hash text,

  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists broker_sync_audit_connection_idx
  on public.broker_sync_audit_events(connection_id, occurred_at desc);
create index if not exists broker_sync_audit_user_idx
  on public.broker_sync_audit_events(user_id, occurred_at desc);

alter table public.broker_sync_audit_events enable row level security;

create policy "broker_sync_audit_owner_select" on public.broker_sync_audit_events
  for select using (auth.uid() = user_id);
create policy "broker_sync_audit_service_insert" on public.broker_sync_audit_events
  for insert with check (auth.uid() = user_id or current_setting('request.jwt.claims', true) is null);
