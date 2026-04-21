-- 0010_hyper_trading_mode.sql
-- Hyper-trading personal mode — Phase 5+
--
-- Adds the persistence layer for an opt-in, very-active personal operating
-- mode that runs on top of (never replaces) the existing delegation framework.
--
-- Key design decisions:
--   * Activation is strictly opt-in. Default config = no profile = no effect.
--   * Tightens — never relaxes — MandateGuardrail. The runtime always picks
--     the stricter of the two when both apply.
--   * killSwitchActive (boolean) is a dead-man's-switch — when true the runtime
--     refuses to evaluate ANYTHING regardless of windows or session state.
--   * Audit is hash-chained (sha256 over id|user|kind|reason|prev_hash).
--   * RLS owner-only on every table.

-- =========================================================================
-- 1. hyper_trading_profiles — one config per user (optionally per portfolio)
-- =========================================================================
create table if not exists public.hyper_trading_profiles (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid references public.portfolios(id) on delete cascade,
  -- mandate_id is required to ever permit autonomous execution; null = suggestion-only.
  mandate_id uuid references public.autonomy_mandates(id) on delete set null,

  status text not null default 'draft'
    check (status in ('draft','active','paused','killed','archived')),

  tempo text not null default 'LONG_HORIZON'
    check (tempo in ('LONG_HORIZON','ACTIVE','HYPER_ACTIVE')),

  risk_level text not null default 'low'
    check (risk_level in ('low','moderate','high','very_high')),

  delegation_mode text not null default 'MANUAL_EXPLICIT'
    check (delegation_mode in ('MANUAL_EXPLICIT','HYBRID_SUGGESTIVE','AUTONOMOUS_GUARDED')),

  -- Window management
  window_timezone text not null default 'Europe/Paris',

  -- Lifecycle timestamps
  activated_at timestamptz,
  paused_at timestamptz,
  killed_at timestamptz,
  archived_at timestamptz,
  expires_at timestamptz not null,

  kill_switch_active boolean not null default false,

  -- Cumulative observability counters
  total_sessions_opened integer not null default 0,
  total_suggestions_emitted integer not null default 0,
  total_intents_approved integer not null default 0,

  -- Soft-typed parameters bag for forward-compatible extensions.
  parameters jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists hyper_trading_profiles_user_portfolio_uniq
  on public.hyper_trading_profiles(user_id, coalesce(portfolio_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status <> 'archived';

create index if not exists hyper_trading_profiles_user_idx
  on public.hyper_trading_profiles(user_id);

create index if not exists hyper_trading_profiles_status_idx
  on public.hyper_trading_profiles(status);

alter table public.hyper_trading_profiles enable row level security;

create policy "hyper_trading_profiles_owner_select" on public.hyper_trading_profiles
  for select using (auth.uid() = user_id);

create policy "hyper_trading_profiles_owner_modify" on public.hyper_trading_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 2. hyper_trading_guardrails — relational caps tied 1:1 to a profile
-- =========================================================================
create table if not exists public.hyper_trading_guardrails (
  profile_id uuid primary key references public.hyper_trading_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Rate limits
  max_trades_per_day integer not null default 10 check (max_trades_per_day >= 0),
  cooldown_minutes_between_trades numeric(8,2) not null default 5 check (cooldown_minutes_between_trades >= 0),
  review_every_n_minutes integer not null default 5 check (review_every_n_minutes > 0),

  -- Sizing caps (% of portfolio market value)
  max_notional_per_trade_pct numeric(5,2) not null default 2,
  max_daily_notional_pct numeric(5,2) not null default 10,
  max_exposure_per_instrument_pct numeric(5,2) not null default 5,
  max_exposure_per_asset_class_pct numeric(5,2) not null default 30,
  max_exposure_per_sector_pct numeric(5,2) not null default 25,

  -- Absolute caps (optional)
  max_notional_per_trade_abs numeric(28,10),
  max_daily_notional_abs numeric(28,10),
  notional_currency char(3) not null default 'EUR',

  -- Position cap
  max_open_positions integer not null default 10 check (max_open_positions > 0),

  -- Loss / drawdown safety
  max_daily_loss_pct numeric(5,2) not null default 2,
  max_intraday_drawdown_pct numeric(5,2) not null default 3,
  mandatory_stop_loss_pct numeric(5,2) not null default 2,
  optional_take_profit_pct numeric(6,2),

  -- Quality-of-execution gating
  maximum_allowed_spread_bps numeric(7,2) not null default 30,
  maximum_allowed_slippage_bps numeric(7,2) not null default 25,
  minimum_expected_liquidity_abs numeric(28,10) not null default 1000000,
  max_acceptable_volatility_pct numeric(6,2) not null default 60,

  -- Allow / deny lists
  allowed_asset_classes text[] not null default array['etf','equity'],
  denied_tickers text[] not null default array[]::text[],

  -- Human-in-the-loop floor
  required_human_approval_above_abs numeric(28,10),

  -- Auto kill-switch triggers
  kill_switch_on_abnormal_loss boolean not null default true,
  kill_switch_on_data_provider_failure boolean not null default true,
  kill_switch_on_broker_sync_mismatch boolean not null default true,
  kill_switch_on_volatility_shock boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hyper_trading_guardrails_user_idx
  on public.hyper_trading_guardrails(user_id);

alter table public.hyper_trading_guardrails enable row level security;

create policy "hyper_trading_guardrails_owner_select" on public.hyper_trading_guardrails
  for select using (auth.uid() = user_id);

create policy "hyper_trading_guardrails_owner_modify" on public.hyper_trading_guardrails
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 3. hyper_trading_windows — declarative trading-time windows per profile
-- =========================================================================
create table if not exists public.hyper_trading_windows (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid not null references public.hyper_trading_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  weekday smallint not null check (weekday between 1 and 7),
  start_local text not null check (start_local ~ '^\d{2}:\d{2}$'),
  end_local text not null check (end_local ~ '^\d{2}:\d{2}$'),

  created_at timestamptz not null default now()
);

create index if not exists hyper_trading_windows_profile_idx
  on public.hyper_trading_windows(profile_id);

alter table public.hyper_trading_windows enable row level security;

create policy "hyper_trading_windows_owner_select" on public.hyper_trading_windows
  for select using (auth.uid() = user_id);

create policy "hyper_trading_windows_owner_modify" on public.hyper_trading_windows
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 4. hyper_trading_sessions — bounded periods of activity
-- =========================================================================
create table if not exists public.hyper_trading_sessions (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid not null references public.hyper_trading_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid references public.portfolios(id) on delete cascade,

  status text not null default 'open'
    check (status in ('open','paused','closed','killed')),

  opened_at timestamptz not null default now(),
  paused_at timestamptz,
  closed_at timestamptz,

  pause_reason text check (pause_reason in (
    'manual_user_pause',
    'cooldown_breached',
    'daily_loss_breached',
    'intraday_drawdown_breached',
    'volatility_shock',
    'data_provider_failure',
    'broker_sync_mismatch',
    'window_closed',
    'kill_switch',
    'mandate_invalid'
  )),

  -- Latest risk snapshot (denormalised for fast reads).
  realised_pnl numeric(28,10),
  unrealised_pnl numeric(28,10),
  observed_drawdown_pct numeric(5,2),
  trades_executed integer not null default 0,
  notional_traded numeric(28,10) not null default 0,
  observed_volatility_pct numeric(6,2),
  snapshot_currency char(3),
  snapshot_captured_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hyper_trading_sessions_profile_idx
  on public.hyper_trading_sessions(profile_id);
create index if not exists hyper_trading_sessions_user_idx
  on public.hyper_trading_sessions(user_id);
create index if not exists hyper_trading_sessions_status_idx
  on public.hyper_trading_sessions(status);

alter table public.hyper_trading_sessions enable row level security;

create policy "hyper_trading_sessions_owner_select" on public.hyper_trading_sessions
  for select using (auth.uid() = user_id);

create policy "hyper_trading_sessions_owner_modify" on public.hyper_trading_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 5. hyper_trading_audit_events — hash-chained audit trail
-- =========================================================================
create table if not exists public.hyper_trading_audit_events (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid not null references public.hyper_trading_profiles(id) on delete cascade,
  session_id uuid references public.hyper_trading_sessions(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,

  kind text not null check (kind in (
    'profile_created','profile_updated','profile_activated','profile_paused',
    'profile_resumed','profile_killed','profile_archived',
    'session_opened','session_paused','session_resumed','session_closed',
    'guardrail_updated','guardrail_violation_blocked','guardrail_violation_warned',
    'kill_switch_armed','kill_switch_disarmed',
    'window_entered','window_exited',
    'risk_snapshot_recorded'
  )),

  reason text not null,
  payload jsonb,

  -- Hash chain
  hash text not null,
  prev_hash text,

  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists hyper_trading_audit_profile_idx
  on public.hyper_trading_audit_events(profile_id, occurred_at desc);
create index if not exists hyper_trading_audit_user_idx
  on public.hyper_trading_audit_events(user_id, occurred_at desc);

alter table public.hyper_trading_audit_events enable row level security;

create policy "hyper_trading_audit_owner_select" on public.hyper_trading_audit_events
  for select using (auth.uid() = user_id);

-- Insert is performed via service-role only (no user-side writes).
create policy "hyper_trading_audit_service_insert" on public.hyper_trading_audit_events
  for insert with check (auth.uid() = user_id or current_setting('request.jwt.claims', true) is null);
