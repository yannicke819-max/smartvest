-- SmartVest — seed data de développement
-- À appliquer APRÈS les migrations 0001 et 0002.
-- Crée des données réalistes multi-actifs, multi-devises, multi-marchés.

-- ===== Marchés =====
insert into public.markets (id, mic, name, country, currency, timezone) values
  ('10000000-0000-0000-0000-000000000001', 'XPAR', 'Euronext Paris',         'FR', 'EUR', 'Europe/Paris'),
  ('10000000-0000-0000-0000-000000000002', 'XNYS', 'New York Stock Exchange','US', 'USD', 'America/New_York'),
  ('10000000-0000-0000-0000-000000000003', 'XNAS', 'NASDAQ',                 'US', 'USD', 'America/New_York'),
  ('10000000-0000-0000-0000-000000000004', 'XCRY', 'Crypto (spot)',          'XX', 'USD', 'UTC')
on conflict do nothing;

-- ===== Brokers =====
insert into public.brokers (id, slug, name, kind, country, supported_currencies, fee_schedule) values
  (
    '20000000-0000-0000-0000-000000000001',
    'degiro',
    'DEGIRO',
    'manual',
    'NL',
    ARRAY['EUR', 'USD', 'GBP'],
    '{"fixedPerOrder":"2.00","percentOfNotional":"0.03","minPerOrder":null,"maxPerOrder":null,"fxMarkupPct":"0.25","currency":"EUR"}'
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    'binance',
    'Binance',
    'manual',
    'MT',
    ARRAY['EUR', 'USD', 'BTC', 'ETH', 'USDT'],
    '{"fixedPerOrder":"0","percentOfNotional":"0.10","minPerOrder":null,"maxPerOrder":null,"fxMarkupPct":"0","currency":"USD"}'
  )
on conflict do nothing;

-- ===== Actifs =====
insert into public.assets (id, isin, ticker, name, asset_class, currency, market_id, sector, country) values
  ('30000000-0000-0000-0000-000000000001', 'IE00B4L5Y983', 'IWDA',  'iShares Core MSCI World ETF',      'etf',    'USD', '10000000-0000-0000-0000-000000000001', 'Global Equity',  'IE'),
  ('30000000-0000-0000-0000-000000000002', 'IE00B3RBWM25', 'VUSA',  'Vanguard S&P 500 UCITS ETF',        'etf',    'USD', '10000000-0000-0000-0000-000000000001', 'US Equity',      'IE'),
  ('30000000-0000-0000-0000-000000000003', 'FR0000131104', 'BNP',   'BNP Paribas SA',                    'equity', 'EUR', '10000000-0000-0000-0000-000000000001', 'Finance',        'FR'),
  ('30000000-0000-0000-0000-000000000004', 'US0378331005', 'AAPL',  'Apple Inc.',                        'equity', 'USD', '10000000-0000-0000-0000-000000000003', 'Technology',     'US'),
  ('30000000-0000-0000-0000-000000000005', 'US5949181045', 'MSFT',  'Microsoft Corporation',              'equity', 'USD', '10000000-0000-0000-0000-000000000003', 'Technology',     'US'),
  ('30000000-0000-0000-0000-000000000006', null,           'BTC',   'Bitcoin',                            'crypto', 'USD', '10000000-0000-0000-0000-000000000004', 'Crypto',         'XX'),
  ('30000000-0000-0000-0000-000000000007', null,           'ETH',   'Ethereum',                           'crypto', 'USD', '10000000-0000-0000-0000-000000000004', 'Crypto',         'XX'),
  ('30000000-0000-0000-0000-000000000008', 'IE00B4WXJJ64', 'AGGH',  'iShares Core Global Aggregate Bond ETF', 'etf', 'EUR', '10000000-0000-0000-0000-000000000001', 'Bond',     'IE'),
  ('30000000-0000-0000-0000-000000000009', 'LU0290358497', 'XGSG',  'Xtrackers II EUR Govt Bond ETF',    'etf',    'EUR', '10000000-0000-0000-0000-000000000001', 'Bond EU',        'LU')
on conflict do nothing;

-- ===== Cotations de référence (snapshot manuel pour seed) =====
insert into public.quotes (asset_id, price, currency, as_of, source) values
  ('30000000-0000-0000-0000-000000000001', 95.23,     'USD', '2026-04-18T16:00:00Z', 'seed'),
  ('30000000-0000-0000-0000-000000000002', 96.48,     'USD', '2026-04-18T16:00:00Z', 'seed'),
  ('30000000-0000-0000-0000-000000000003', 6.82,      'EUR', '2026-04-18T17:30:00Z', 'seed'),
  ('30000000-0000-0000-0000-000000000004', 192.35,    'USD', '2026-04-18T16:00:00Z', 'seed'),
  ('30000000-0000-0000-0000-000000000005', 418.50,    'USD', '2026-04-18T16:00:00Z', 'seed'),
  ('30000000-0000-0000-0000-000000000006', 84200.00,  'USD', '2026-04-18T20:00:00Z', 'seed'),
  ('30000000-0000-0000-0000-000000000007', 3120.00,   'USD', '2026-04-18T20:00:00Z', 'seed'),
  ('30000000-0000-0000-0000-000000000008', 4.91,      'EUR', '2026-04-18T16:00:00Z', 'seed'),
  ('30000000-0000-0000-0000-000000000009', 180.42,    'EUR', '2026-04-18T16:00:00Z', 'seed')
on conflict do nothing;

-- ===== Taux de change (snapshot) =====
insert into public.fx_rates (base, quote, rate, as_of, source) values
  ('EUR', 'USD', '1.0820', '2026-04-18T20:00:00Z', 'seed'),
  ('USD', 'EUR', '0.9242', '2026-04-18T20:00:00Z', 'seed'),
  ('GBP', 'EUR', '1.1675', '2026-04-18T20:00:00Z', 'seed'),
  ('EUR', 'GBP', '0.8565', '2026-04-18T20:00:00Z', 'seed'),
  ('USD', 'GBP', '0.7916', '2026-04-18T20:00:00Z', 'seed')
on conflict do nothing;

-- ===== NOTE : Portefeuille, comptes, positions et transactions =====
-- Ces données doivent être associées à un vrai user_id (auth.users).
-- En développement, créez un compte via Supabase Auth, récupérez l'ID,
-- puis exécutez les instructions suivantes en remplaçant <YOUR_USER_ID> :

/*
-- 1) Profil utilisateur
insert into public.user_profiles (id, display_name, locale, base_currency, risk_profile, onboarding_completed)
values ('<YOUR_USER_ID>', 'Développeur SmartVest', 'fr-FR', 'EUR', 'dynamique', true)
on conflict (id) do update set risk_profile = 'dynamique', onboarding_completed = true;

-- 2) Portefeuille
insert into public.portfolios (id, user_id, name, base_currency, description) values
  ('40000000-0000-0000-0000-000000000001', '<YOUR_USER_ID>', 'Portefeuille Principal', 'EUR', 'long_term — profil dynamique')
on conflict do nothing;

-- 3) Compte
insert into public.portfolio_accounts (id, portfolio_id, broker_id, kind, label, account_currency) values
  (
    '50000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'brokerage',
    'DEGIRO — Compte titres',
    'EUR'
  )
on conflict do nothing;

-- 4) Positions
insert into public.positions (id, account_id, asset_id, quantity, average_cost, cost_currency) values
  ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '52',      '87.40', 'USD'),
  ('60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '35',      '88.10', 'USD'),
  ('60000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000004', '10',      '175.20', 'USD'),
  ('60000000-0000-0000-0000-000000000004', '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000006', '0.15',   '52000.00', 'USD'),
  ('60000000-0000-0000-0000-000000000005', '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', '200',    '7.35', 'EUR')
on conflict do nothing;

-- 5) Transactions (exemples)
insert into public.transactions
  (id, account_id, asset_id, type, trade_date, quantity, unit_price, currency, execution, note)
values
  (
    '70000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'buy', '2025-03-15T09:30:00Z', '52', '87.40', 'USD',
    '{"grossAmount":"4544.80","brokerFee":"3.54","exchangeFee":"0","taxes":"0","spreadCost":"0","slippageCost":"1.30","fxMarkup":"10.23","netAmount":"4559.87","feeCurrency":"EUR","benchmarkPrice":null,"benchmarkSource":null}',
    'Achat initial IWDA'
  ),
  (
    '70000000-0000-0000-0000-000000000002',
    '50000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000004',
    'buy', '2025-06-10T14:00:00Z', '10', '175.20', 'USD',
    '{"grossAmount":"1752.00","brokerFee":"2.53","exchangeFee":"0","taxes":"0","spreadCost":"0","slippageCost":"0.52","fxMarkup":"4.06","netAmount":"1759.11","feeCurrency":"EUR","benchmarkPrice":null,"benchmarkSource":null}',
    'Renforcement Apple'
  ),
  (
    '70000000-0000-0000-0000-000000000003',
    '50000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000006',
    'buy', '2025-09-01T10:00:00Z', '0.15', '52000.00', 'USD',
    '{"grossAmount":"7800.00","brokerFee":"7.80","exchangeFee":"0","taxes":"0","spreadCost":"0","slippageCost":"15.60","fxMarkup":"0","netAmount":"7823.40","feeCurrency":"USD","benchmarkPrice":null,"benchmarkSource":null}',
    'Entrée Bitcoin — exposition crypto limitée'
  )
on conflict do nothing;
*/
