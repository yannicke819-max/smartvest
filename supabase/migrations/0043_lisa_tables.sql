-- Migration 0043 — Tables Lisa (AI analyst simulation)
--
-- Tables :
--   - lisa_proposals         : propositions d'allocation générées par Lisa
--   - lisa_positions         : positions simulées (paper trading)
--   - lisa_portfolio_snapshots : P&L snapshots pour charts (1d/1w/1m/1y)
--   - lisa_decision_log      : traçabilité hash-chaînée des actions
--   - lisa_session_configs   : configurations de session user
--
-- Respect CLAUDE.md :
--   - Portfolios is_simulation=true obligatoire pour toute entrée Lisa
--   - Delegation mode MANUAL_EXPLICIT par défaut (user valide chaque proposal)
--   - RLS stricte user-scoped

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. lisa_session_configs
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.lisa_session_configs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,

  profile text not null check (profile in (
    'long_term_investor', 'active_trading', 'sniper_mode', 'hyper_active'
  )),
  capital_usd numeric(28,2) not null,
  base_currency char(3) not null default 'EUR',

  risk_constraints jsonb not null default '{}'::jsonb,
  include_asset_classes text[],
  exclude_asset_classes text[],
  anti_consensus_strength integer not null default 7 check (anti_consensus_strength between 0 and 10),
  max_theses integer not null default 5 check (max_theses between 1 and 7),

  enable_crypto boolean not null default true,
  enable_derivatives boolean not null default false,
  enable_leverage boolean not null default false,

  autopilot_enabled boolean not null default false,
  autopilot_cycle_minutes integer default 60,

  kill_switch_active boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (portfolio_id)
);

create index if not exists lisa_session_configs_user_idx on public.lisa_session_configs(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. lisa_proposals
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.lisa_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  session_config_id uuid references public.lisa_session_configs(id),

  capital_usd numeric(28,2) not null,
  base_currency char(3) not null,
  detected_regime text not null,
  regime_summary text not null,

  favored_pockets jsonb not null default '[]'::jsonb,
  avoided_pockets jsonb not null default '[]'::jsonb,
  theses jsonb not null default '[]'::jsonb,
  allocations jsonb not null default '[]'::jsonb,
  cash_reserve_pct numeric(6,3) not null default 100,
  portfolio_risk_lens jsonb not null default '{}'::jsonb,
  constraints_used jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,

  status text not null default 'draft' check (status in (
    'draft', 'proposed', 'approved', 'rejected', 'executed', 'expired'
  )),

  -- Metadata Claude call
  claude_model text,
  claude_input_tokens integer,
  claude_output_tokens integer,
  claude_cached_tokens integer,
  claude_cost_usd numeric(10,6),

  generated_at timestamptz not null default now(),
  expires_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists lisa_proposals_user_portfolio_idx
  on public.lisa_proposals(user_id, portfolio_id, status);
create index if not exists lisa_proposals_generated_at_idx
  on public.lisa_proposals(generated_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. lisa_positions
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.lisa_positions (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  proposal_id uuid not null references public.lisa_proposals(id) on delete restrict,
  thesis_id uuid not null,

  symbol text not null,
  asset_class text not null,
  direction text not null check (direction in (
    'long', 'short', 'long_call', 'long_put', 'short_call', 'short_put', 'pair_spread'
  )),
  venue text not null,

  quantity numeric(28,10) not null,
  entry_price numeric(28,10) not null,
  entry_timestamp timestamptz not null,
  entry_notional_usd numeric(28,2) not null,

  status text not null default 'open' check (status in (
    'open', 'closed_target', 'closed_stop', 'closed_invalidated',
    'closed_user', 'closed_kill', 'closed_expired'
  )),

  exit_price numeric(28,10),
  exit_timestamp timestamptz,
  exit_reason text,
  realized_pnl_usd numeric(28,2),
  realized_pnl_pct numeric(10,4),

  stop_loss_price numeric(28,10),
  take_profit_price numeric(28,10),
  horizon_target_date timestamptz,

  estimated_entry_cost_usd numeric(28,2) not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lisa_positions_portfolio_status_idx
  on public.lisa_positions(portfolio_id, status);
create index if not exists lisa_positions_thesis_idx
  on public.lisa_positions(thesis_id);
create index if not exists lisa_positions_entry_timestamp_idx
  on public.lisa_positions(entry_timestamp desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. lisa_portfolio_snapshots (pour charts 1d/1w/1m/1y)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.lisa_portfolio_snapshots (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  timestamp timestamptz not null default now(),

  cash_usd numeric(28,2) not null,
  open_positions_value_usd numeric(28,2) not null,
  total_value_usd numeric(28,2) not null,
  realized_pnl_cumulative_usd numeric(28,2) not null default 0,
  unrealized_pnl_usd numeric(28,2) not null default 0,
  return_from_inception_pct numeric(10,4) not null default 0,
  open_positions_count integer not null default 0,
  drawdown_from_peak_pct numeric(10,4) not null default 0,

  market_context_summary text
);

create index if not exists lisa_snapshots_portfolio_time_idx
  on public.lisa_portfolio_snapshots(portfolio_id, timestamp desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. lisa_decision_log (hash-chaînée)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.lisa_decision_log (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,

  kind text not null check (kind in (
    'proposal_generated', 'proposal_approved', 'proposal_rejected',
    'position_opened', 'position_closed', 'position_resized',
    'thesis_invalidated', 'risk_limit_breached', 'kill_switch_triggered',
    'autopilot_cycle_started', 'autopilot_cycle_completed',
    'market_regime_changed', 'analog_matched', 'user_override'
  )),
  summary text not null,
  rationale text not null,
  payload jsonb not null default '{}'::jsonb,

  hash_chain_prev text,
  hash_chain_current text not null default '',

  triggered_by text not null check (triggered_by in (
    'user_manual', 'autopilot_cron', 'risk_monitor', 'corpus_trigger', 'market_event'
  )),
  timestamp timestamptz not null default now()
);

create index if not exists lisa_decision_log_portfolio_time_idx
  on public.lisa_decision_log(portfolio_id, timestamp desc);
create index if not exists lisa_decision_log_kind_idx
  on public.lisa_decision_log(kind);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS : user-scoped sur toutes les tables Lisa
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.lisa_session_configs enable row level security;
alter table public.lisa_proposals enable row level security;
alter table public.lisa_positions enable row level security;
alter table public.lisa_portfolio_snapshots enable row level security;
alter table public.lisa_decision_log enable row level security;

-- Owner-only policies
create policy "lisa_session_configs_owner" on public.lisa_session_configs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "lisa_proposals_owner" on public.lisa_proposals
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Pour lisa_positions, lisa_portfolio_snapshots, lisa_decision_log :
-- accès via jointure portfolio owner
create policy "lisa_positions_owner" on public.lisa_positions
  for all using (
    exists (select 1 from public.portfolios p
            where p.id = portfolio_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.portfolios p
            where p.id = portfolio_id and p.user_id = auth.uid())
  );

create policy "lisa_portfolio_snapshots_owner" on public.lisa_portfolio_snapshots
  for all using (
    exists (select 1 from public.portfolios p
            where p.id = portfolio_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.portfolios p
            where p.id = portfolio_id and p.user_id = auth.uid())
  );

create policy "lisa_decision_log_owner" on public.lisa_decision_log
  for all using (
    exists (select 1 from public.portfolios p
            where p.id = portfolio_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.portfolios p
            where p.id = portfolio_id and p.user_id = auth.uid())
  );

-- Service role bypass RLS (pour backend NestJS)
grant all on public.lisa_session_configs to service_role;
grant all on public.lisa_proposals to service_role;
grant all on public.lisa_positions to service_role;
grant all on public.lisa_portfolio_snapshots to service_role;
grant all on public.lisa_decision_log to service_role;

-- Authenticated grants (frontend lectures directes si besoin)
grant select, insert, update, delete on public.lisa_session_configs to authenticated;
grant select, insert, update, delete on public.lisa_proposals to authenticated;
grant select on public.lisa_positions to authenticated;
grant select on public.lisa_portfolio_snapshots to authenticated;
grant select on public.lisa_decision_log to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Triggers updated_at
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.touch_lisa_updated_at()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_lisa_session_configs_updated on public.lisa_session_configs;
create trigger trg_lisa_session_configs_updated
  before update on public.lisa_session_configs
  for each row execute function public.touch_lisa_updated_at();

drop trigger if exists trg_lisa_positions_updated on public.lisa_positions;
create trigger trg_lisa_positions_updated
  before update on public.lisa_positions
  for each row execute function public.touch_lisa_updated_at();
