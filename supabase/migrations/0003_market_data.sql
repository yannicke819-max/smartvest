-- Migration 0003 — schéma données marché Phase 3
-- Étend quotes, ajoute bars_daily, market_data_jobs, provider_tickers.

-- ===== Enrichir la table quotes existante =====
alter table public.quotes
  add column if not exists provider text not null default 'manual',
  add column if not exists market_state text check (market_state in ('open','closed','pre','after','unknown')) default 'unknown',
  add column if not exists previous_close numeric(28,10),
  add column if not exists change_absolute numeric(28,10),
  add column if not exists change_percent numeric(12,6),
  add column if not exists fetched_at timestamptz not null default now(),
  add column if not exists raw_payload jsonb;

-- Index sur provider pour filtrer par source
create index if not exists quotes_provider_idx on public.quotes(provider);

-- Mettre à jour la vue latest_quotes avec les nouveaux champs
create or replace view public.latest_quotes as
select distinct on (asset_id)
  asset_id, price, currency, as_of, source, provider,
  market_state, previous_close, change_absolute, change_percent, fetched_at
from public.quotes
order by asset_id, as_of desc;

-- ===== Barres journalières OHLCV =====
create table if not exists public.bars_daily (
  id uuid primary key default uuid_generate_v4(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  provider text not null default 'eodhd',
  date date not null,
  open numeric(28,10),
  high numeric(28,10),
  low numeric(28,10),
  close numeric(28,10) not null,
  adjusted_close numeric(28,10),
  volume bigint,
  currency char(3) not null,
  fetched_at timestamptz not null default now(),
  unique (asset_id, provider, date)
);

create index if not exists bars_daily_asset_date_idx on public.bars_daily(asset_id, date desc);
create index if not exists bars_daily_date_idx on public.bars_daily(date desc);

alter table public.bars_daily enable row level security;
create policy "bars_daily_readable_by_authenticated"
  on public.bars_daily for select
  using (auth.role() = 'authenticated');

-- ===== Tickers par provider sur les actifs =====
-- Stocker {"eodhd": "AAPL.US", "binance": "BTCUSDT"}
alter table public.assets
  add column if not exists provider_tickers jsonb not null default '{}';

-- Mettre à jour les actifs seed avec leurs tickers EOD
update public.assets set provider_tickers = '{"eodhd":"IWDA.AS"}'   where ticker = 'IWDA';
update public.assets set provider_tickers = '{"eodhd":"VUSA.LSE"}'  where ticker = 'VUSA';
update public.assets set provider_tickers = '{"eodhd":"BNP.PA"}'    where ticker = 'BNP';
update public.assets set provider_tickers = '{"eodhd":"AAPL.US"}'   where ticker = 'AAPL';
update public.assets set provider_tickers = '{"eodhd":"MSFT.US"}'   where ticker = 'MSFT';
update public.assets set provider_tickers = '{"eodhd":"BTC-USD.CC"}' where ticker = 'BTC';
update public.assets set provider_tickers = '{"eodhd":"ETH-USD.CC"}' where ticker = 'ETH';
update public.assets set provider_tickers = '{"eodhd":"AGGH.LSE"}'  where ticker = 'AGGH';
update public.assets set provider_tickers = '{"eodhd":"XGSG.XETRA"}' where ticker = 'XGSG';

-- ===== Suivi des jobs de refresh =====
create table if not exists public.market_data_jobs (
  id uuid primary key default uuid_generate_v4(),
  job_type text not null check (job_type in ('quote_refresh','bar_refresh','fx_refresh')),
  provider text not null default 'eodhd',
  status text not null default 'pending' check (status in ('pending','running','done','failed')),
  assets_requested int default 0,
  assets_succeeded int default 0,
  assets_failed int default 0,
  error_details jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Les jobs sont insérés/lus par le service (service role uniquement en prod).
alter table public.market_data_jobs enable row level security;
create policy "market_data_jobs_readable_by_authenticated"
  on public.market_data_jobs for select
  using (auth.role() = 'authenticated');

-- ===== Vue performance simple pour front =====
-- Retourne close vs adjusted_close sur la dernière barre disponible
create or replace view public.latest_bars as
select distinct on (asset_id, provider)
  asset_id, provider, date, open, high, low, close, adjusted_close, volume, currency, fetched_at
from public.bars_daily
order by asset_id, provider, date desc;
