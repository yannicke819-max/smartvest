-- 0009_funding_module.sql
-- Funding / Cash management module — Phase 5+
--
-- Introduces the ledger-based cash management subsystem. SmartVest is NEVER
-- a deposit custodian: we only *record* transfers initiated by the user to
-- their investment account. A transfer in state "settled" credits the
-- destination account's cash balance; nothing here triggers a broker order.
--
-- Tables (8):
--   funding_sources          — user-declared bank accounts (source side)
--   funding_destinations     — investment/broker accounts (destination side)
--   funding_transfers        — transfer intents with full state machine
--   cash_balances            — denormalised per-account-per-currency balance (fast reads)
--   cash_ledger_entries      — append-only journal: every cash movement is one row
--   cash_reservations        — soft-locks on available cash for plans/goals/suggestions
--   funding_allocation_links — link a transfer to a goal / portfolio / plan / proposal
--   funding_audit_events     — hash-chained audit trail of every funding transition
--
-- All monetary fields use numeric(28,10) — never float.
-- RLS enforces owner-only access on user_id.

-- =========================================================================
-- Funding sources (user's bank accounts — declarative, never used for real RTP)
-- =========================================================================
create table if not exists public.funding_sources (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  -- Optional structured identifiers (never required, never shown in logs)
  iban_last4 text,     -- last 4 chars only; never full IBAN
  bank_name text,
  currency char(3) not null default 'EUR',
  is_archived boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists funding_sources_user_idx on public.funding_sources(user_id);

alter table public.funding_sources enable row level security;
create policy "funding_sources_owner"
  on public.funding_sources for all
  using (auth.uid() = user_id);

-- =========================================================================
-- Funding destinations (investment / broker / cash accounts SmartVest tracks)
-- =========================================================================
create table if not exists public.funding_destinations (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid references public.portfolios(id) on delete set null,
  portfolio_account_id uuid references public.portfolio_accounts(id) on delete set null,
  broker_account_ref text,  -- opaque external ref if known (not used for auth)
  label text not null,
  currency char(3) not null default 'EUR',
  is_archived boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists funding_destinations_user_idx on public.funding_destinations(user_id);
create index if not exists funding_destinations_portfolio_idx on public.funding_destinations(portfolio_id);

alter table public.funding_destinations enable row level security;
create policy "funding_destinations_owner"
  on public.funding_destinations for all
  using (auth.uid() = user_id);

-- =========================================================================
-- Funding transfers (state machine: draft → initiated → pending_settlement → settled)
-- =========================================================================
create table if not exists public.funding_transfers (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid references public.portfolios(id) on delete set null,
  portfolio_account_id uuid references public.portfolio_accounts(id) on delete set null,

  source_id uuid references public.funding_sources(id) on delete set null,
  destination_id uuid not null references public.funding_destinations(id) on delete restrict,

  status text not null default 'draft' check (status in (
    'draft','initiated','pending_settlement','settled','partially_settled',
    'cancelled','failed','reversed'
  )),
  method text not null check (method in (
    'bank_transfer','manual_record','broker_internal_transfer','cash_adjustment'
  )),

  -- Amounts — requested_amount is what the user declared; settled_amount reflects what's actually credited
  currency char(3) not null,
  requested_amount numeric(28,10) not null check (requested_amount >= 0),
  settled_amount numeric(28,10) not null default 0 check (settled_amount >= 0),

  -- Dates
  initiated_at timestamptz,
  expected_settlement_date date,
  settled_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  reversed_at timestamptz,

  -- Failure / reversal context (free text, user-visible)
  failure_reason text,
  reversal_reason text,

  note text,
  metadata jsonb not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists funding_transfers_user_idx on public.funding_transfers(user_id);
create index if not exists funding_transfers_portfolio_idx on public.funding_transfers(portfolio_id);
create index if not exists funding_transfers_status_idx on public.funding_transfers(status);
create index if not exists funding_transfers_dest_idx on public.funding_transfers(destination_id);

alter table public.funding_transfers enable row level security;
create policy "funding_transfers_owner"
  on public.funding_transfers for all
  using (auth.uid() = user_id);

-- =========================================================================
-- Cash balances (denormalised — one row per (destination, currency))
-- Rebuildable from cash_ledger_entries but maintained for fast dashboard reads.
-- =========================================================================
create table if not exists public.cash_balances (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  destination_id uuid not null references public.funding_destinations(id) on delete cascade,
  currency char(3) not null,

  -- All numbers follow: total = settled, settled = pending_in + available + reserved
  settled numeric(28,10) not null default 0,
  pending_in numeric(28,10) not null default 0,   -- in-transit inbound (transfers not yet settled)
  reserved numeric(28,10) not null default 0,     -- soft-locked by reservations
  -- available is a computed view: settled - reserved

  updated_at timestamptz not null default now(),
  unique (destination_id, currency)
);

create index if not exists cash_balances_user_idx on public.cash_balances(user_id);

alter table public.cash_balances enable row level security;
create policy "cash_balances_owner"
  on public.cash_balances for all
  using (auth.uid() = user_id);

-- =========================================================================
-- Cash ledger (append-only journal of every cash movement — source of truth)
-- =========================================================================
create table if not exists public.cash_ledger_entries (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  destination_id uuid not null references public.funding_destinations(id) on delete cascade,
  currency char(3) not null,

  movement_type text not null check (movement_type in (
    'deposit','withdrawal','transfer_in','transfer_out',
    'settlement_credit','settlement_debit',
    'reservation','reservation_release','adjustment'
  )),

  -- Signed amount: positive = credit, negative = debit. Always in `currency`.
  amount numeric(28,10) not null,

  -- Links (nullable — not every ledger entry has one)
  transfer_id uuid references public.funding_transfers(id) on delete set null,
  reservation_id uuid,   -- fk added after cash_reservations is created (see below)

  -- Running balance snapshot (at time of this entry) for audit & fast scans
  balance_after numeric(28,10) not null,

  description text,
  metadata jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists cash_ledger_entries_dest_idx on public.cash_ledger_entries(destination_id, occurred_at desc);
create index if not exists cash_ledger_entries_user_idx on public.cash_ledger_entries(user_id, occurred_at desc);
create index if not exists cash_ledger_entries_transfer_idx on public.cash_ledger_entries(transfer_id);

alter table public.cash_ledger_entries enable row level security;
create policy "cash_ledger_entries_owner"
  on public.cash_ledger_entries for all
  using (auth.uid() = user_id);

-- =========================================================================
-- Cash reservations (soft-lock on available cash — e.g. "reserved for Retirement goal")
-- =========================================================================
create table if not exists public.cash_reservations (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  destination_id uuid not null references public.funding_destinations(id) on delete cascade,
  currency char(3) not null,
  amount numeric(28,10) not null check (amount > 0),

  status text not null default 'active' check (status in ('active','released','consumed')),

  -- Why is it reserved? Optional links to business objects
  goal_id uuid references public.goals(id) on delete set null,
  proposal_id uuid references public.action_proposals(id) on delete set null,
  plan_id uuid,                        -- objective_plans (fk loose, table may be renamed)
  reason text not null,                -- free-text label shown to user

  expires_at timestamptz,              -- optional auto-release
  released_at timestamptz,
  consumed_at timestamptz,

  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cash_reservations_user_idx on public.cash_reservations(user_id);
create index if not exists cash_reservations_dest_idx on public.cash_reservations(destination_id, status);
create index if not exists cash_reservations_goal_idx on public.cash_reservations(goal_id);

alter table public.cash_reservations enable row level security;
create policy "cash_reservations_owner"
  on public.cash_reservations for all
  using (auth.uid() = user_id);

-- Now that cash_reservations exists, add the FK from cash_ledger_entries.reservation_id
alter table public.cash_ledger_entries
  add constraint cash_ledger_entries_reservation_fk
  foreign key (reservation_id) references public.cash_reservations(id) on delete set null;

-- =========================================================================
-- Funding allocation links (transfer ↔ goal/portfolio/plan/proposal)
-- A single transfer can feed multiple goals; a goal can receive multiple transfers.
-- =========================================================================
create table if not exists public.funding_allocation_links (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  transfer_id uuid not null references public.funding_transfers(id) on delete cascade,

  link_kind text not null check (link_kind in ('goal','portfolio','plan','proposal')),
  goal_id uuid references public.goals(id) on delete cascade,
  portfolio_id uuid references public.portfolios(id) on delete cascade,
  plan_id uuid,
  proposal_id uuid references public.action_proposals(id) on delete cascade,

  -- Split: one transfer can be partially allocated (e.g. 60 % to goal A, 40 % to goal B)
  allocated_amount numeric(28,10) not null check (allocated_amount > 0),
  currency char(3) not null,

  note text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),

  -- Exactly one target per link
  constraint funding_allocation_links_single_target check (
    (case when goal_id is not null then 1 else 0 end) +
    (case when portfolio_id is not null then 1 else 0 end) +
    (case when plan_id is not null then 1 else 0 end) +
    (case when proposal_id is not null then 1 else 0 end) = 1
  )
);

create index if not exists funding_allocation_links_transfer_idx on public.funding_allocation_links(transfer_id);
create index if not exists funding_allocation_links_goal_idx on public.funding_allocation_links(goal_id);
create index if not exists funding_allocation_links_portfolio_idx on public.funding_allocation_links(portfolio_id);

alter table public.funding_allocation_links enable row level security;
create policy "funding_allocation_links_owner"
  on public.funding_allocation_links for all
  using (auth.uid() = user_id);

-- =========================================================================
-- Funding audit events (hash-chained, mirrors autonomy_audit_events pattern)
-- =========================================================================
create table if not exists public.funding_audit_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  transfer_id uuid references public.funding_transfers(id) on delete set null,
  reservation_id uuid references public.cash_reservations(id) on delete set null,

  kind text not null check (kind in (
    'transfer_created','transfer_updated','transfer_initiated',
    'transfer_settled','transfer_partially_settled',
    'transfer_cancelled','transfer_failed','transfer_reversed',
    'reservation_created','reservation_released','reservation_consumed',
    'allocation_linked','allocation_unlinked',
    'cash_adjustment'
  )),

  -- Optional state snapshots (before/after) for forensic reads
  prev_status text,
  new_status text,
  amount numeric(28,10),
  currency char(3),

  reason text,

  -- Hash chain (matches autonomy_audit_events)
  prev_hash text,
  hash text not null,

  metadata jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

create index if not exists funding_audit_events_user_idx on public.funding_audit_events(user_id, occurred_at desc);
create index if not exists funding_audit_events_transfer_idx on public.funding_audit_events(transfer_id);

alter table public.funding_audit_events enable row level security;
create policy "funding_audit_events_owner"
  on public.funding_audit_events for all
  using (auth.uid() = user_id);
