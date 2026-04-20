-- SmartVest — schéma initial (Phase 1)
-- Montants stockés en NUMERIC pour précision décimale (jamais FLOAT).
-- Toutes les tables ont created_at et, quand pertinent, updated_at.

create extension if not exists "uuid-ossp";

-- ===== Référentiels =====

create table if not exists public.markets (
  id uuid primary key default uuid_generate_v4(),
  mic char(4) not null unique,
  name text not null,
  country char(2) not null,
  currency char(3) not null,
  timezone text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.brokers (
  id uuid primary key default uuid_generate_v4(),
  slug text not null unique,
  name text not null,
  kind text not null check (kind in ('manual', 'api_readonly', 'api_execution')),
  country char(2) not null,
  supported_currencies text[] not null default '{}',
  fee_schedule jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.assets (
  id uuid primary key default uuid_generate_v4(),
  isin char(12),
  ticker text not null,
  name text not null,
  asset_class text not null check (asset_class in (
    'equity','etf','bond','fund','cash','crypto','commodity','derivative','other'
  )),
  currency char(3) not null,
  market_id uuid references public.markets(id),
  sector text,
  country char(2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ticker, market_id)
);

create table if not exists public.fx_rates (
  base char(3) not null,
  quote char(3) not null,
  rate numeric(20, 10) not null,
  as_of timestamptz not null,
  source text not null,
  primary key (base, quote, as_of)
);

-- ===== Utilisateurs & portefeuilles =====

-- auth.users est géré par Supabase Auth. Profil applicatif ici :
create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  locale text not null default 'fr-FR',
  base_currency char(3) not null default 'EUR',
  risk_profile text check (risk_profile in (
    'prudent','equilibre','dynamique','offensif','sur_mesure'
  )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portfolios (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  base_currency char(3) not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists portfolios_user_id_idx on public.portfolios(user_id);

create table if not exists public.portfolio_accounts (
  id uuid primary key default uuid_generate_v4(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  broker_id uuid references public.brokers(id),
  kind text not null check (kind in (
    'cash','brokerage','pea','ira','crypto_exchange','wallet','other'
  )),
  label text not null,
  account_currency char(3) not null,
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists portfolio_accounts_portfolio_id_idx
  on public.portfolio_accounts(portfolio_id);

create table if not exists public.positions (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references public.portfolio_accounts(id) on delete cascade,
  asset_id uuid not null references public.assets(id),
  quantity numeric(28, 10) not null,
  average_cost numeric(28, 10) not null,
  cost_currency char(3) not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists positions_account_id_idx on public.positions(account_id);

create table if not exists public.transactions (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references public.portfolio_accounts(id) on delete cascade,
  asset_id uuid references public.assets(id),
  type text not null check (type in (
    'buy','sell','dividend','interest','fee','tax',
    'transfer_in','transfer_out','fx','split','adjustment'
  )),
  trade_date timestamptz not null,
  settle_date timestamptz,
  quantity numeric(28, 10),
  unit_price numeric(28, 10),
  currency char(3) not null,
  execution jsonb,
  external_ref text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists transactions_account_id_idx on public.transactions(account_id);
create index if not exists transactions_trade_date_idx on public.transactions(trade_date);

-- ===== Scénarios & audit =====

create table if not exists public.scenario_runs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid references public.portfolios(id) on delete set null,
  kind text not null check (kind in (
    'allocation_simulation','rebalance_projection','monte_carlo','stress_test','cost_impact'
  )),
  engine_version text not null,
  inputs jsonb not null,
  outputs jsonb not null,
  assumptions text[] not null default '{}',
  disclaimers text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists scenario_runs_user_id_idx on public.scenario_runs(user_id);

-- Journal append-only avec hash chaîné. Insertion only (à gater au niveau API/RLS).
create table if not exists public.execution_audits (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in (
    'user_auth','portfolio_create','portfolio_update','account_link',
    'transaction_import','transaction_create','scenario_run','flag_toggle',
    'suggestion_view','suggestion_act','order_draft','order_submit'
  )),
  subject_type text not null,
  subject_id text,
  payload jsonb not null,
  prev_hash text,
  hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists execution_audits_user_id_idx on public.execution_audits(user_id);

-- ===== Row Level Security =====

alter table public.user_profiles enable row level security;
alter table public.portfolios enable row level security;
alter table public.portfolio_accounts enable row level security;
alter table public.positions enable row level security;
alter table public.transactions enable row level security;
alter table public.scenario_runs enable row level security;
alter table public.execution_audits enable row level security;

create policy "user_profiles_own_row"
  on public.user_profiles for all
  using (id = auth.uid()) with check (id = auth.uid());

create policy "portfolios_own_row"
  on public.portfolios for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "portfolio_accounts_through_portfolio"
  on public.portfolio_accounts for all
  using (exists (
    select 1 from public.portfolios p
    where p.id = portfolio_id and p.user_id = auth.uid()
  ));

create policy "positions_through_account"
  on public.positions for all
  using (exists (
    select 1 from public.portfolio_accounts a
    join public.portfolios p on p.id = a.portfolio_id
    where a.id = account_id and p.user_id = auth.uid()
  ));

create policy "transactions_through_account"
  on public.transactions for all
  using (exists (
    select 1 from public.portfolio_accounts a
    join public.portfolios p on p.id = a.portfolio_id
    where a.id = account_id and p.user_id = auth.uid()
  ));

create policy "scenario_runs_own_row"
  on public.scenario_runs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Audits : lecture propre à l'utilisateur, insertion via service role uniquement.
create policy "execution_audits_read_own"
  on public.execution_audits for select
  using (user_id = auth.uid());
