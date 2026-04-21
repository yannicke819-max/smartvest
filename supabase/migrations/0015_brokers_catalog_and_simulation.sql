-- Migration 0015 — enrichissement brokers + flag simulation portefeuille
--
-- 1. Ajoute website_url, description à la table brokers pour permettre
--    au catalogue de lier chaque broker vers son site officiel.
-- 2. Ajoute is_simulation à portfolios pour marquer les portefeuilles
--    "paper trading" (aucune connexion broker réelle, trades purement
--    virtuels, données visibles explicitement comme simulation).
-- 3. Seed / upsert les brokers connus avec leurs URLs officielles.
--
-- Aucune rupture de compat : colonnes nullable pour website_url/description,
-- is_simulation défaut false.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Extension schéma brokers
-- ─────────────────────────────────────────────────────────────────────────────
alter table if exists public.brokers
  add column if not exists website_url text,
  add column if not exists description text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Extension schéma portfolios pour marquer les portefeuilles de simulation
-- ─────────────────────────────────────────────────────────────────────────────
alter table if exists public.portfolios
  add column if not exists is_simulation boolean not null default false,
  add column if not exists simulation_initial_capital numeric(28,2);

create index if not exists portfolios_is_simulation_idx
  on public.portfolios(is_simulation)
  where is_simulation = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Seed / upsert des brokers connus
-- ─────────────────────────────────────────────────────────────────────────────
-- Brokers actions/ETF/dérivés
insert into public.brokers (slug, name, kind, country, supported_currencies, is_active, website_url, description)
values
  ('interactive_brokers', 'Interactive Brokers', 'api_execution', 'US',
   array['USD','EUR','GBP','CHF','JPY','HKD','SGD'], true,
   'https://www.interactivebrokers.com',
   'Broker global actions/ETF/options/futures. Frais très compétitifs, API mature.'),
  ('saxo', 'Saxo Banque', 'api_execution', 'DK',
   array['EUR','USD','GBP','CHF','DKK'], true,
   'https://www.home.saxo',
   'Broker européen premium actions/options/FX. API OpenAPI complète.'),
  ('trading212', 'Trading 212', 'api_execution', 'GB',
   array['EUR','USD','GBP'], true,
   'https://www.trading212.com',
   'Broker retail actions/ETF sans commission. API REST lecture + exécution.'),
  ('trade_republic', 'Trade Republic', 'manual', 'DE',
   array['EUR'], true,
   'https://traderepublic.com',
   'Broker mobile européen actions/ETF/crypto. Pas d''API publique — import manuel ou CSV.'),
  ('etoro', 'eToro', 'manual', 'IL',
   array['USD','EUR','GBP'], true,
   'https://www.etoro.com',
   'Broker social trading multi-actifs. Pas d''API retail publique.'),
  ('revolut', 'Revolut', 'manual', 'LT',
   array['EUR','USD','GBP'], true,
   'https://www.revolut.com',
   'Néobanque avec offre trading actions/crypto. Pas d''API trading publique.'),
  ('degiro', 'DEGIRO', 'manual', 'NL',
   array['EUR','USD','GBP'], true,
   'https://www.degiro.com',
   'Broker low-cost européen. Pas d''API — import via CSV ou saisie manuelle.'),
  ('bourse_direct', 'Bourse Direct', 'manual', 'FR',
   array['EUR','USD'], true,
   'https://www.boursedirect.fr',
   'Broker français (PEA, CTO, assurance-vie). Pas d''API — CSV.'),
  ('fortuneo', 'Fortuneo', 'manual', 'FR',
   array['EUR','USD'], true,
   'https://www.fortuneo.fr',
   'Banque en ligne française avec offre bourse (PEA, CTO). Pas d''API — CSV.')
on conflict (slug) do update set
  name = excluded.name,
  kind = excluded.kind,
  country = excluded.country,
  supported_currencies = excluded.supported_currencies,
  is_active = excluded.is_active,
  website_url = excluded.website_url,
  description = excluded.description;

-- Brokers crypto
insert into public.brokers (slug, name, kind, country, supported_currencies, is_active, website_url, description)
values
  ('binance', 'Binance', 'api_execution', 'MT',
   array['EUR','USD','BTC','ETH','USDT','USDC','BNB'], true,
   'https://www.binance.com',
   'Plus grande plateforme crypto au monde. API REST + WebSocket. Spot, futures, options.'),
  ('kraken', 'Kraken', 'api_execution', 'US',
   array['EUR','USD','GBP','BTC','ETH','USDT','USDC'], true,
   'https://www.kraken.com',
   'Exchange crypto US réputé pour sa sécurité. API REST + WebSocket.'),
  ('coinbase', 'Coinbase', 'api_execution', 'US',
   array['EUR','USD','GBP','BTC','ETH','USDT','USDC'], true,
   'https://www.coinbase.com',
   'Exchange crypto US coté en bourse. API Advanced Trade pour pros.'),
  ('crypto_com', 'Crypto.com', 'manual', 'SG',
   array['EUR','USD','BTC','ETH','USDT','CRO'], true,
   'https://crypto.com',
   'Exchange crypto + carte Visa. API disponible sur demande.')
on conflict (slug) do update set
  name = excluded.name,
  kind = excluded.kind,
  country = excluded.country,
  supported_currencies = excluded.supported_currencies,
  is_active = excluded.is_active,
  website_url = excluded.website_url,
  description = excluded.description;
