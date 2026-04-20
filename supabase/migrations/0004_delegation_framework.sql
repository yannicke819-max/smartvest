-- Migration 0004 — cadre de délégation Phase 4
-- Ajoute : autonomy_mandates, mandate_guardrails, execution_policies,
--          action_proposals, action_approvals, autonomy_audit_events, broker_connections.

-- ===== Mandate guardrails (embedded in mandate, also stored for history) =====
create table if not exists public.autonomy_mandates (
  id uuid primary key default uuid_generate_v4(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  status text not null default 'pending_activation'
    check (status in ('pending_activation','active','suspended','expired','revoked')),
  label text not null,

  -- Guardrail caps (all pct fields are 0-100)
  max_position_size_pct numeric(6,2) not null,
  max_single_trade_pct numeric(6,2) not null,
  max_daily_trade_pct numeric(6,2) not null,
  max_single_trade_notional numeric(28,10),
  max_single_trade_notional_currency char(3),
  allowed_asset_classes text[] not null default '{}',
  forbidden_tickers text[] not null default '{}',
  requires_human_above_pct numeric(6,2) not null,
  stop_loss_trigger_pct numeric(6,2) not null,
  max_open_positions int,

  -- Lifecycle
  activated_at timestamptz,
  expires_at timestamptz not null,
  suspended_at timestamptz,
  revoked_at timestamptz,
  kill_switch_active boolean not null default false,

  -- Cumulative counters
  total_actions_executed int not null default 0,
  total_notional_traded numeric(28,10) not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists autonomy_mandates_portfolio_idx on public.autonomy_mandates(portfolio_id);
create index if not exists autonomy_mandates_user_idx on public.autonomy_mandates(user_id);
-- Only one active mandate per portfolio at a time
create unique index if not exists autonomy_mandates_one_active
  on public.autonomy_mandates(portfolio_id)
  where status = 'active';

alter table public.autonomy_mandates enable row level security;
create policy "autonomy_mandates_owner"
  on public.autonomy_mandates for all
  using (auth.uid() = user_id);

-- ===== Execution policies =====
create table if not exists public.execution_policies (
  id uuid primary key default uuid_generate_v4(),
  mandate_id uuid not null references public.autonomy_mandates(id) on delete cascade,
  delegation_mode text not null check (delegation_mode in ('MANUAL_EXPLICIT','HYBRID_SUGGESTIVE','AUTONOMOUS_GUARDED')),
  order_type text not null default 'limit' check (order_type in ('market','limit','limit_post_only')),
  limit_price_offset_pct numeric(6,4),
  timing text not null default 'market_open'
    check (timing in ('immediate','market_open','market_close','next_business_day')),
  max_retries int not null default 2,
  retry_delay_seconds int not null default 60,
  notional_currency char(3) not null default 'EUR',
  allow_partial_fill boolean not null default false,
  min_fill_ratio numeric(4,3) not null default 1.000,
  kill_switch_active boolean not null default false,
  kill_switch_reason text,
  kill_switch_triggered_by text check (kill_switch_triggered_by in ('user','stop_loss','system','expiry')),
  kill_switch_triggered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.execution_policies enable row level security;
create policy "execution_policies_via_mandate"
  on public.execution_policies for all
  using (
    exists (
      select 1 from public.autonomy_mandates m
      where m.id = mandate_id and m.user_id = auth.uid()
    )
  );

-- ===== Action proposals =====
create table if not exists public.action_proposals (
  id uuid primary key default uuid_generate_v4(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mandate_id uuid references public.autonomy_mandates(id),

  kind text not null check (kind in ('information','simulation','suggestion','execution_intent','execution')),
  delegation_mode text not null check (delegation_mode in ('MANUAL_EXPLICIT','HYBRID_SUGGESTIVE','AUTONOMOUS_GUARDED')),
  lifecycle_state text not null default 'draft'
    check (lifecycle_state in ('draft','presented','approved','rejected','expired','executed','cancelled')),

  action text not null check (action in ('buy','sell','rebalance','contribute','withdraw','fx','other')),
  asset_id uuid references public.assets(id),
  ticker text,
  quantity numeric(28,10),
  notional numeric(28,10),
  currency char(3),

  rationale text not null,
  assumptions jsonb not null default '[]',

  -- Estimated friction snapshot
  estimated_broker_fee numeric(28,10),
  estimated_spread_cost numeric(28,10),
  estimated_slippage_cost numeric(28,10),
  estimated_fx_markup numeric(28,10),
  estimated_total_friction numeric(28,10),
  friction_currency char(3),

  presented_at timestamptz,
  expires_at timestamptz,
  executed_at timestamptz,
  execution_audit_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists action_proposals_portfolio_idx on public.action_proposals(portfolio_id);
create index if not exists action_proposals_lifecycle_idx on public.action_proposals(lifecycle_state);

alter table public.action_proposals enable row level security;
create policy "action_proposals_owner"
  on public.action_proposals for all
  using (auth.uid() = user_id);

-- ===== Action approvals =====
create table if not exists public.action_approvals (
  id uuid primary key default uuid_generate_v4(),
  proposal_id uuid not null references public.action_proposals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  decision text not null check (decision in ('approved','rejected','modified')),
  modified_quantity numeric(28,10),
  modified_notional numeric(28,10),
  note text,
  decided_at timestamptz not null default now()
);

alter table public.action_approvals enable row level security;
create policy "action_approvals_owner"
  on public.action_approvals for all
  using (auth.uid() = user_id);

-- ===== Autonomy audit events =====
create table if not exists public.autonomy_audit_events (
  id uuid primary key default uuid_generate_v4(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mandate_id uuid references public.autonomy_mandates(id),
  proposal_id uuid references public.action_proposals(id),

  kind text not null check (kind in (
    'mandate_created','mandate_activated','mandate_suspended','mandate_revoked','mandate_expired',
    'kill_switch_triggered','kill_switch_released',
    'proposal_presented','proposal_approved','proposal_rejected',
    'execution_attempted','execution_succeeded','execution_failed',
    'guardrail_blocked','stop_loss_triggered','policy_violation'
  )),
  delegation_mode text not null check (delegation_mode in ('MANUAL_EXPLICIT','HYBRID_SUGGESTIVE','AUTONOMOUS_GUARDED')),

  portfolio_value_at_event numeric(28,10),
  portfolio_currency char(3),
  action text,
  ticker text,
  notional numeric(28,10),
  reason text not null,

  guardrail_field text,
  guardrail_value jsonb,
  guardrail_limit jsonb,

  prev_hash text,
  hash text not null,

  occurred_at timestamptz not null default now()
);

create index if not exists autonomy_audit_events_portfolio_idx on public.autonomy_audit_events(portfolio_id, occurred_at desc);
create index if not exists autonomy_audit_events_mandate_idx on public.autonomy_audit_events(mandate_id);

-- Audit events are append-only: no update or delete
alter table public.autonomy_audit_events enable row level security;
create policy "autonomy_audit_events_readable_by_owner"
  on public.autonomy_audit_events for select
  using (auth.uid() = user_id);

-- ===== Broker connections =====
create table if not exists public.broker_connections (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references public.portfolio_accounts(id) on delete cascade,
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  broker_id uuid not null references public.brokers(id),

  sync_mode text not null default 'read_only'
    check (sync_mode in ('read_only','execution_preview','execution_live')),
  status text not null default 'disconnected'
    check (status in ('connected','disconnected','error','pending_auth','suspended')),

  last_positions_sync_at timestamptz,
  last_transactions_sync_at timestamptz,
  last_balance_sync_at timestamptz,

  authorized_mandate_id uuid references public.autonomy_mandates(id),
  error_message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.broker_connections enable row level security;
create policy "broker_connections_owner"
  on public.broker_connections for all
  using (auth.uid() = user_id);
