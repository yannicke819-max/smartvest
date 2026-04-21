-- Migration 0005 — Phase 4 : imports brokers, historique, benchmarks, alertes paramétrables
-- Préparation connecteurs broker read-only, multi-provider market data healthchecks.

-- ===== Import jobs (CSV broker) =====
create table if not exists public.import_jobs (
  id uuid primary key default uuid_generate_v4(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('csv','api','manual')),
  broker_format text not null,            -- 'interactive_brokers' | 'degiro' | 'generic'
  account_id uuid references public.portfolio_accounts(id),
  filename text,
  file_sha256 text,                       -- detect re-upload of identical file
  status text not null default 'pending'
    check (status in ('pending','previewed','committed','failed','cancelled')),
  rows_detected int not null default 0,
  rows_valid int not null default 0,
  rows_invalid int not null default 0,
  rows_committed int not null default 0,
  error_summary text,
  created_at timestamptz not null default now(),
  previewed_at timestamptz,
  committed_at timestamptz,
  cancelled_at timestamptz
);

create index if not exists import_jobs_portfolio_idx on public.import_jobs(portfolio_id, created_at desc);

alter table public.import_jobs enable row level security;
create policy "import_jobs_owner" on public.import_jobs for all using (auth.uid() = user_id);

-- ===== Import rows (per-line preview buffer) =====
create table if not exists public.import_rows (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references public.import_jobs(id) on delete cascade,
  row_number int not null,                -- line number in source CSV
  raw_payload jsonb not null,             -- full source row for audit

  -- Normalized fields (null if validation failed)
  trade_date date,
  action text,                            -- 'buy' | 'sell' | 'dividend' | ...
  ticker text,
  isin text,
  quantity numeric(28,10),
  unit_price numeric(28,10),
  currency char(3),
  broker_fee numeric(28,10),
  tax numeric(28,10),
  fx_rate numeric(28,10),

  asset_id uuid references public.assets(id),
  matched_asset_confidence numeric(4,3),  -- 0-1 score for asset matching

  status text not null default 'pending'
    check (status in ('pending','valid','invalid','duplicate','committed','skipped')),
  validation_errors jsonb default '[]',
  duplicate_of_transaction_id uuid,

  created_at timestamptz not null default now()
);

create index if not exists import_rows_job_idx on public.import_rows(job_id, row_number);
create index if not exists import_rows_status_idx on public.import_rows(job_id, status);

alter table public.import_rows enable row level security;
create policy "import_rows_via_job" on public.import_rows for all using (
  exists (select 1 from public.import_jobs j where j.id = job_id and j.user_id = auth.uid())
);

-- ===== Portfolio history snapshots (daily point-in-time valuations) =====
create table if not exists public.portfolio_history_snapshots (
  id uuid primary key default uuid_generate_v4(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  as_of_date date not null,
  currency char(3) not null,
  total_market_value numeric(28,10) not null,
  total_cost_basis numeric(28,10) not null,
  cash_balance numeric(28,10) not null default 0,
  pnl_absolute numeric(28,10) not null,
  pnl_percent numeric(12,6) not null,
  position_count int not null default 0,
  allocation_snapshot jsonb,              -- { asset_class: weight }
  source text not null default 'computed',-- 'computed' | 'imported'
  created_at timestamptz not null default now(),
  unique (portfolio_id, as_of_date)
);

create index if not exists portfolio_history_idx on public.portfolio_history_snapshots(portfolio_id, as_of_date desc);

alter table public.portfolio_history_snapshots enable row level security;
create policy "portfolio_history_readable_by_owner"
  on public.portfolio_history_snapshots for select
  using (
    exists (select 1 from public.portfolios p where p.id = portfolio_id and p.user_id = auth.uid())
  );

-- ===== Benchmark series (indices, ETF proxies) =====
create table if not exists public.benchmarks (
  id uuid primary key default uuid_generate_v4(),
  ticker text not null unique,            -- e.g. 'MSCI_WORLD', 'SPX', 'BTC'
  name text not null,
  description text,
  provider text not null default 'eodhd',
  provider_ticker text,                   -- e.g. 'URTH.US' for MSCI World proxy
  currency char(3) not null default 'USD',
  created_at timestamptz not null default now()
);

create table if not exists public.benchmark_series (
  id uuid primary key default uuid_generate_v4(),
  benchmark_id uuid not null references public.benchmarks(id) on delete cascade,
  as_of_date date not null,
  close numeric(28,10) not null,
  total_return_index numeric(28,10),      -- reinvested dividends if available
  unique (benchmark_id, as_of_date)
);

create index if not exists benchmark_series_idx on public.benchmark_series(benchmark_id, as_of_date desc);

-- Readable by all authenticated (benchmark data is not user-specific)
alter table public.benchmarks enable row level security;
alter table public.benchmark_series enable row level security;
create policy "benchmarks_read_auth" on public.benchmarks for select using (auth.role() = 'authenticated');
create policy "benchmark_series_read_auth" on public.benchmark_series for select using (auth.role() = 'authenticated');

-- Map portfolios to their configured benchmark
alter table public.portfolios
  add column if not exists benchmark_id uuid references public.benchmarks(id);

-- ===== Alert rules (parameterizable per portfolio) =====
create table if not exists public.alert_rules (
  id uuid primary key default uuid_generate_v4(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rule_kind text not null,
  -- 'allocation_drift_persistent' | 'threshold_breach' | 'asset_large_move'
  -- | 'drawdown_exceeded' | 'concentration_excessive' | 'quote_stale' | 'import_anomaly'
  severity text not null default 'warning' check (severity in ('info','warning','critical')),
  enabled boolean not null default true,
  params jsonb not null default '{}',     -- rule-specific thresholds
  cooldown_seconds int not null default 3600, -- min seconds between same-alert firings
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists alert_rules_portfolio_idx on public.alert_rules(portfolio_id) where enabled = true;

alter table public.alert_rules enable row level security;
create policy "alert_rules_owner" on public.alert_rules for all using (auth.uid() = user_id);

-- ===== Alerts (persisted firings of alert rules) =====
create table if not exists public.alerts (
  id uuid primary key default uuid_generate_v4(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rule_id uuid references public.alert_rules(id) on delete set null,
  rule_kind text not null,
  severity text not null check (severity in ('info','warning','critical')),
  title text not null,
  description text not null,
  affected_ticker text,
  value text,
  threshold text,
  context jsonb,
  read_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists alerts_portfolio_unread_idx
  on public.alerts(portfolio_id, created_at desc)
  where read_at is null and dismissed_at is null;

alter table public.alerts enable row level security;
create policy "alerts_owner" on public.alerts for all using (auth.uid() = user_id);

-- ===== Market data provider health =====
create table if not exists public.market_data_provider_health (
  id uuid primary key default uuid_generate_v4(),
  provider text not null,                 -- 'eodhd' | 'yahoo' | 'manual' | ...
  check_type text not null check (check_type in ('quote','bar','fx')),
  status text not null check (status in ('healthy','degraded','down')),
  latency_ms int,
  error_message text,
  checked_at timestamptz not null default now()
);

create index if not exists provider_health_idx on public.market_data_provider_health(provider, checked_at desc);

alter table public.market_data_provider_health enable row level security;
create policy "provider_health_read_auth"
  on public.market_data_provider_health for select
  using (auth.role() = 'authenticated');

-- ===== Broker connector jobs (read-only connector plumbing, no execution) =====
-- Renamed from broker_sync_jobs to free that name for the user-facing
-- broker-connection layer (migration 0012).
create table if not exists public.broker_connector_jobs (
  id uuid primary key default uuid_generate_v4(),
  link_id uuid references public.broker_sync_links(id) on delete cascade,
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  sync_kind text not null check (sync_kind in ('positions','transactions','balance','full')),
  status text not null default 'pending'
    check (status in ('pending','running','done','failed','cancelled')),
  rows_synced int default 0,
  rows_errored int default 0,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists broker_connector_jobs_portfolio_idx on public.broker_connector_jobs(portfolio_id, created_at desc);

alter table public.broker_connector_jobs enable row level security;
create policy "broker_connector_jobs_owner" on public.broker_connector_jobs for all using (auth.uid() = user_id);

-- ===== Seed some benchmarks for default wiring =====
insert into public.benchmarks (ticker, name, description, provider, provider_ticker, currency)
values
  ('MSCI_WORLD', 'MSCI World (IWDA proxy)', 'Indice actions développées, proxy ETF iShares Core MSCI World', 'eodhd', 'IWDA.AS', 'EUR'),
  ('SP500',      'S&P 500',                  'Indice actions US large-cap, proxy ETF Vanguard VUSA',         'eodhd', 'VUSA.LSE', 'USD'),
  ('BTC_USD',    'Bitcoin / USD',            'Cours Bitcoin en USD',                                         'eodhd', 'BTC-USD.CC','USD')
on conflict (ticker) do nothing;
