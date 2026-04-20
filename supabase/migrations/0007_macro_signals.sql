-- Macro / Géopolitique / Impact / RETEX module

-- Macro signals (unified table for all signal categories)
create table if not exists macro_signals (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in (
    'central_bank_decision','inflation_data','growth_data','employment_data',
    'fx_move','commodity_move','geopolitical_tension','election_event',
    'regulatory_change','market_stress','earnings_surprise','credit_event'
  )),
  status text not null default 'ingested' check (status in (
    'ingested','assessed','concluded','archived','dismissed'
  )),
  title text not null,
  summary text not null default '',
  raw_content text,
  -- SignalSource embedded
  source_kind text not null default 'manual' check (source_kind in ('manual','rss','webhook','api','user_input')),
  source_name text not null,
  source_url text,
  source_reliability_score numeric(4,3),
  -- Signal attributes
  severity text not null default 'info' check (severity in ('info','watch','warning','critical','systemic')),
  confidence text not null default 'medium' check (confidence in ('low','medium','high')),
  impact_horizon text not null default 'short_term' check (impact_horizon in ('immediate','short_term','medium_term','long_term')),
  geographic_zones text[] not null default '{}',
  countries text[] not null default '{}',
  affected_sectors text[] not null default '{}',
  affected_currencies text[] not null default '{}',
  affected_asset_classes text[] not null default '{}',
  references text[] not null default '{}',
  tags text[] not null default '{}',
  occurred_at timestamptz not null default now(),
  ingested_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- No RLS on macro_signals — they are global market signals, not user-scoped.
-- Access is read-only for all authenticated users.
alter table macro_signals enable row level security;
create policy "macro_signals: authenticated read" on macro_signals for select using (auth.role() = 'authenticated');
create policy "macro_signals: service write" on macro_signals for insert with check (true);
create policy "macro_signals: service update" on macro_signals for update using (true);

create index if not exists macro_signals_category_idx on macro_signals(category);
create index if not exists macro_signals_severity_idx on macro_signals(severity);
create index if not exists macro_signals_occurred_at_idx on macro_signals(occurred_at desc);

-- Signal impact assessments
create table if not exists signal_impact_assessments (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references macro_signals(id) on delete cascade,
  asset_exposures jsonb not null default '[]',
  sector_exposures jsonb not null default '[]',
  portfolio_impacts jsonb not null default '[]',
  overall_severity text not null,
  overall_confidence text not null,
  assessed_at timestamptz not null default now(),
  notes text
);

alter table signal_impact_assessments enable row level security;
create policy "signal_impact_assessments: authenticated read" on signal_impact_assessments for select using (auth.role() = 'authenticated');
create policy "signal_impact_assessments: service write" on signal_impact_assessments for all using (true);

-- Asset-level signal exposures (links to portfolio positions)
create table if not exists asset_signal_exposures (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references macro_signals(id) on delete cascade,
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  asset_id uuid,
  ticker text,
  isin text,
  direction text not null check (direction in ('positive','negative','uncertain','neutral')),
  magnitude_pct numeric(8,4),
  rationale text not null,
  confidence text not null,
  created_at timestamptz not null default now()
);

alter table asset_signal_exposures enable row level security;
create policy "asset_signal_exposures: owner via portfolio" on asset_signal_exposures for all
  using (exists (select 1 from portfolios p where p.id = portfolio_id and p.user_id = auth.uid()));

-- Portfolio-level signal impact estimates
create table if not exists portfolio_signal_impacts (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references macro_signals(id) on delete cascade,
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  estimated_impact_pct numeric(8,4),
  exposed_position_count int not null default 0,
  exposed_notional_pct numeric(8,4),
  currency char(3) not null default 'EUR',
  aggravating_factors jsonb not null default '[]',
  mitigating_factors jsonb not null default '[]',
  invalidation_conditions jsonb not null default '[]',
  estimated_at timestamptz not null default now()
);

alter table portfolio_signal_impacts enable row level security;
create policy "portfolio_signal_impacts: owner via portfolio" on portfolio_signal_impacts for all
  using (exists (select 1 from portfolios p where p.id = portfolio_id and p.user_id = auth.uid()));

create unique index if not exists portfolio_signal_impacts_ux on portfolio_signal_impacts(signal_id, portfolio_id);

-- Historical analogs
create table if not exists historical_analogs (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references macro_signals(id) on delete cascade,
  episode_title text not null,
  episode_date_start date not null,
  episode_date_end date,
  context_description text not null,
  similarity_score numeric(4,3) not null,
  key_drivers jsonb not null default '[]',
  resolution text,
  asset_class_behaviors jsonb not null default '[]',
  limitations_of_comparison jsonb not null default '[]',
  created_at timestamptz not null default now()
);

alter table historical_analogs enable row level security;
create policy "historical_analogs: authenticated read" on historical_analogs for select using (auth.role() = 'authenticated');
create policy "historical_analogs: service write" on historical_analogs for all using (true);

-- RETEX insights
create table if not exists retex_insights (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references macro_signals(id) on delete cascade,
  analog_id uuid not null references historical_analogs(id) on delete cascade,
  lesson text not null,
  applicability_note text not null,
  observed_behavior text not null,
  confidence_level text not null check (confidence_level in ('low','medium','high')),
  created_at timestamptz not null default now()
);

alter table retex_insights enable row level security;
create policy "retex_insights: authenticated read" on retex_insights for select using (auth.role() = 'authenticated');
create policy "retex_insights: service write" on retex_insights for all using (true);

-- Signal conclusions
create table if not exists signal_conclusions (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references macro_signals(id) on delete cascade,
  summary_text text not null,
  exposed_assets jsonb not null default '[]',
  exposed_sectors jsonb not null default '[]',
  probable_scenario text not null,
  main_risk text not null,
  counter_arguments jsonb not null default '[]',
  overall_confidence text not null,
  needs_review boolean not null default false,
  output_mode text not null check (output_mode in ('information','alert','simulation','suggestion','action_candidate')),
  proposed_actions jsonb not null default '[]',
  delegation_mode text not null default 'MANUAL_EXPLICIT',
  generated_at timestamptz not null default now()
);

alter table signal_conclusions enable row level security;
create policy "signal_conclusions: authenticated read" on signal_conclusions for select using (auth.role() = 'authenticated');
create policy "signal_conclusions: service write" on signal_conclusions for all using (true);

-- Signal watch events (per-user signal tracking)
create table if not exists signal_watch_events (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references macro_signals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_kind text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table signal_watch_events enable row level security;
create policy "signal_watch_events: owner access" on signal_watch_events for all using (auth.uid() = user_id);
