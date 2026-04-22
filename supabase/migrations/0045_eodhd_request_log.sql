-- Log table pour tracer chaque requête EODHD (prix live).
-- Utilisé par la page /admin/monitoring pour afficher le vrai compteur
-- de consommation du quota provider.
--
-- Pas de FK vers portfolios (peut être null pour les appels hors contexte
-- portfolio, ex: market snapshot). Fire-and-forget côté backend pour ne
-- pas ralentir le chemin live-price.

create table if not exists eodhd_request_log (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  eodhd_ticker text,
  source text not null default 'eodhd',
  success boolean not null default true,
  status_code integer,
  latency_ms integer,
  price_usd numeric(20,8),
  called_by text,
  portfolio_id uuid,
  error_message text,
  timestamp timestamptz not null default now()
);

create index if not exists idx_eodhd_req_log_timestamp
  on eodhd_request_log (timestamp desc);

create index if not exists idx_eodhd_req_log_source
  on eodhd_request_log (source);

comment on table eodhd_request_log is
  'Log des appels à l''API EODHD (prix live). Utilisé pour le monitoring quota.';
comment on column eodhd_request_log.source is
  'eodhd = appel réel réussi, fallback = prix statique, supabase_quotes = cache DB';
comment on column eodhd_request_log.called_by is
  'live_price = fetchLivePrice, market_snapshot = fetchMarketSnapshot';
