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

-- ===== Signaux macro (démo) — données globales, indépendantes de l'utilisateur =====
-- 4 signaux couvrant : taux, géopolitique, inflation, secteur
insert into public.macro_signals (
  id, category, status, title, summary,
  source_kind, source_name, severity, confidence, impact_horizon,
  geographic_zones, countries, affected_sectors, affected_currencies, affected_asset_classes,
  tags, occurred_at
) values
  (
    '80000000-0000-0000-0000-000000000001',
    'central_bank_decision', 'concluded',
    'BCE : maintien du taux directeur à 3,25 %, ton prudent sur l''horizon 2026',
    'La Banque centrale européenne a laissé son taux directeur inchangé à 3,25 % lors de sa réunion d''avril. Le communiqué évoque une inflation encore au-dessus de l''objectif et repousse l''horizon d''assouplissement potentiel.',
    'manual', 'seed-demo', 'warning', 'high', 'medium_term',
    ARRAY['eurozone','europe'], ARRAY['FR','DE','IT','ES'],
    ARRAY['Bonds EU','Finance','Real Estate'],
    ARRAY['EUR'], ARRAY['bond','etf','equity'],
    ARRAY['ecb','rates','eurozone'], '2026-04-17T12:00:00Z'
  ),
  (
    '80000000-0000-0000-0000-000000000002',
    'geopolitical_tension', 'assessed',
    'Tensions au détroit d''Ormuz : prime de risque sur le pétrole et le transport maritime',
    'Regain de tensions diplomatiques autour du détroit d''Ormuz la semaine dernière. Les marchés du pétrole et du transport maritime intègrent une prime de risque, certains indices énergétiques ont progressé de 4 %.',
    'manual', 'seed-demo', 'critical', 'medium', 'short_term',
    ARRAY['middle_east','global'], ARRAY['IR','AE','SA'],
    ARRAY['Energy','Transport','Defense'],
    ARRAY['USD'], ARRAY['equity','etf','crypto'],
    ARRAY['geopolitics','oil','shipping'], '2026-04-16T08:30:00Z'
  ),
  (
    '80000000-0000-0000-0000-000000000003',
    'inflation_data', 'concluded',
    'Inflation zone euro : +2,9 % en mars, au-dessus des attentes',
    'Eurostat publie une inflation CPI de 2,9 % YoY pour mars 2026, contre 2,6 % attendu. L''inflation core reste collante à 3,1 %, principalement due aux services.',
    'manual', 'seed-demo', 'warning', 'high', 'short_term',
    ARRAY['eurozone'], ARRAY['FR','DE','IT','ES','NL'],
    ARRAY['Services','Real Estate','Consumer Staples'],
    ARRAY['EUR'], ARRAY['bond','etf','equity'],
    ARRAY['inflation','cpi','eurozone'], '2026-04-15T10:00:00Z'
  ),
  (
    '80000000-0000-0000-0000-000000000004',
    'market_stress', 'concluded',
    'Secteur tech US : correction de 6 % après résultats trimestriels mitigés',
    'Les valeurs technologiques américaines (Nasdaq 100) ont corrigé de 6 % sur la semaine suite à des résultats trimestriels mitigés de plusieurs poids lourds. La dispersion intra-secteur augmente.',
    'manual', 'seed-demo', 'watch', 'medium', 'short_term',
    ARRAY['north_america'], ARRAY['US'],
    ARRAY['Technology','Semiconductors','Cloud'],
    ARRAY['USD'], ARRAY['equity','etf'],
    ARRAY['tech','earnings','nasdaq'], '2026-04-14T21:00:00Z'
  )
on conflict do nothing;

-- Conclusions associées aux signaux (alimentent les widgets Contexte marché / Exposition)
insert into public.signal_conclusions (
  signal_id, summary_text, exposed_assets, exposed_sectors,
  probable_scenario, main_risk, counter_arguments, overall_confidence,
  needs_review, output_mode, proposed_actions, delegation_mode
) values
  (
    '80000000-0000-0000-0000-000000000001',
    'Le maintien des taux par la BCE continue de peser sur les obligations longues et le secteur immobilier. Les valeurs financières bénéficient modestement de la pente de la courbe.',
    '["AGGH","XGSG"]'::jsonb,
    '["Bond EU","Real Estate","Finance"]'::jsonb,
    'Horizon d''assouplissement repoussé au T4 2026. Courbe EUR légèrement plus pentue.',
    'Surprise hawkish lors du prochain meeting — choc de duration sur les obligations longues.',
    '["Inflation pourrait revenir plus vite si l''énergie se normalise","Risque de récession peut forcer une baisse anticipée"]'::jsonb,
    'high', false, 'alert',
    '["Revoir l''exposition duration","Surveiller les REIT européens"]'::jsonb,
    'MANUAL_EXPLICIT'
  ),
  (
    '80000000-0000-0000-0000-000000000002',
    'La tension géopolitique au Moyen-Orient expose directement les portefeuilles énergie/transport. Les actifs refuges (or, CHF) peuvent bénéficier d''un rebond.',
    '["BTC","ETH"]'::jsonb,
    '["Energy","Transport","Defense"]'::jsonb,
    'Volatilité élevée sur 2-6 semaines, prime de risque pétrole maintenue à +8 %.',
    'Escalade militaire avec fermeture partielle du détroit — choc d''offre sur le pétrole.',
    '["Détente diplomatique rapide possible","Stocks stratégiques US/Europe peuvent absorber un choc court"]'::jsonb,
    'medium', true, 'action_candidate',
    '["Vérifier exposition directe secteur énergie","Envisager couverture tactique"]'::jsonb,
    'HYBRID_SUGGESTIVE'
  ),
  (
    '80000000-0000-0000-0000-000000000003',
    'L''inflation plus élevée que prévu renforce la pression sur les obligations et réduit le pouvoir d''achat des consommateurs. Les valeurs services sont mécaniquement sensibles.',
    '["AGGH","XGSG","BNP"]'::jsonb,
    '["Services","Real Estate","Consumer Staples","Finance"]'::jsonb,
    'Le marché repricent 1 baisse de moins sur 2026. Obligations EUR sous pression continue.',
    'Inflation qui re-accélère au T2 2026 — BCE forcée de rester restrictive plus longtemps.',
    '["Base effects favorables au T3 2026","Demande en ralentissement pourrait désinflater"]'::jsonb,
    'high', false, 'alert',
    '["Surveiller l''inflation sous-jacente","Réévaluer l''allocation obligataire"]'::jsonb,
    'MANUAL_EXPLICIT'
  ),
  (
    '80000000-0000-0000-0000-000000000004',
    'La correction tech US affecte directement les portefeuilles exposés aux grandes valeurs technologiques et aux ETF Nasdaq. La dispersion intra-secteur augmente.',
    '["AAPL","MSFT","IWDA","VUSA"]'::jsonb,
    '["Technology","Semiconductors","Cloud"]'::jsonb,
    'Correction sectorielle limitée à 8-10 % avant rebond ; la dispersion des résultats reste le facteur clé.',
    'Récession discrète des revenus cloud au T2 — extension de la correction à -15 %.',
    '["Valorisations pré-correction étaient tendues, un reset est sain","Cash flows restent solides"]'::jsonb,
    'medium', false, 'information',
    '["Revoir la concentration single-name","Diversifier vers d''autres secteurs"]'::jsonb,
    'MANUAL_EXPLICIT'
  )
on conflict do nothing;

-- ===== NOTE : Portefeuille, comptes, positions, transactions, goals, mandat, suggestions =====
-- Ces données doivent être associées à un vrai user_id (auth.users).
--
-- Pour la démo : créez un utilisateur `demo@smartvest.fr` via Supabase Auth
-- (Dashboard → Authentication → Add user → email demo@smartvest.fr + mot de passe).
-- Récupérez son user_id, puis exécutez les instructions ci-dessous après avoir
-- remplacé <DEMO_USER_ID> par cet UUID.

/*
-- 1) Profil utilisateur
insert into public.user_profiles (id, display_name, locale, base_currency, risk_profile, onboarding_completed)
values ('<DEMO_USER_ID>', 'Démo SmartVest', 'fr-FR', 'EUR', 'equilibre', true)
on conflict (id) do update set risk_profile = 'equilibre', onboarding_completed = true;

-- 2) Portefeuille
insert into public.portfolios (id, user_id, name, base_currency, description) values
  ('40000000-0000-0000-0000-000000000001', '<DEMO_USER_ID>', 'Portefeuille Démo', 'EUR', 'long_term — profil equilibre')
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

-- 4) Positions (portefeuille démo 5-6 lignes, mix ETF World / obligations EU / equity EU / cash)
insert into public.positions (id, account_id, asset_id, quantity, average_cost, cost_currency) values
  ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '52',      '87.40', 'USD'),  -- IWDA (ETF World)
  ('60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '35',      '88.10', 'USD'),  -- VUSA (S&P 500)
  ('60000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', '200',     '7.35',  'EUR'),  -- BNP (CAC40)
  ('60000000-0000-0000-0000-000000000004', '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008', '180',     '4.75',  'EUR'),  -- AGGH (Oblig globales)
  ('60000000-0000-0000-0000-000000000005', '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000009', '45',      '178.20','EUR'),  -- XGSG (Oblig souv. EU)
  ('60000000-0000-0000-0000-000000000006', '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000004', '8',       '175.20','USD')   -- AAPL
on conflict do nothing;

-- 5) Goals (2 objectifs : retraite long-terme + projet immobilier moyen-terme)
insert into public.goals (id, user_id, portfolio_id, type, status, name, description, target_amount, currency, current_amount, monthly_contribution, horizon_months, target_date) values
  (
    '90000000-0000-0000-0000-000000000001', '<DEMO_USER_ID>', '40000000-0000-0000-0000-000000000001',
    'retirement', 'active',
    'Retraite — complément de revenu',
    'Constituer un capital complémentaire pour la retraite dans 20 ans.',
    '300000', 'EUR', '42000', '400', 240, '2046-04-01'
  ),
  (
    '90000000-0000-0000-0000-000000000002', '<DEMO_USER_ID>', '40000000-0000-0000-0000-000000000001',
    'real_estate', 'active',
    'Apport immobilier',
    'Accumuler un apport de 50 000 € pour un achat résidentiel d''ici 5 ans.',
    '50000', 'EUR', '8500', '600', 60, '2031-06-01'
  )
on conflict do nothing;

-- 6) Mandat MANUAL_EXPLICIT actif (analyse / simulation uniquement, aucune action autonome)
insert into public.autonomy_mandates (
  id, portfolio_id, user_id, status, label,
  max_position_size_pct, max_single_trade_pct, max_daily_trade_pct,
  allowed_asset_classes, forbidden_tickers,
  requires_human_above_pct, stop_loss_trigger_pct,
  activated_at, expires_at
) values (
  'a0000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '<DEMO_USER_ID>',
  'active',
  'Mandat démo — analyse uniquement',
  30, 5, 15,
  ARRAY['etf','bond','equity','cash'], ARRAY['GME','AMC'],
  3, 20,
  now(), '2027-04-18T00:00:00Z'
) on conflict do nothing;

-- 7) Suggestions d'exemple (état "presented" pour peupler la page /suggestions)
insert into public.action_proposals (
  id, portfolio_id, user_id, mandate_id, kind, delegation_mode, lifecycle_state,
  action, ticker, notional, currency, rationale, assumptions,
  source_kind, dedup_key,
  estimated_broker_fee, estimated_slippage_cost, estimated_fx_markup, estimated_total_friction, friction_currency,
  presented_at, expires_at
) values
  (
    'b0000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001', '<DEMO_USER_ID>', 'a0000000-0000-0000-0000-000000000001',
    'suggestion', 'HYBRID_SUGGESTIVE', 'presented',
    'rebalance', 'AGGH', '1500.00', 'EUR',
    'Dérive d''allocation détectée sur la classe "bond" : sous-exposé de 7.2 points (actuel 27.8% vs cible 35.0% pour profil equilibre).',
    '["Profil de risque : equilibre","Allocation actuelle bond : 27.8%","Allocation cible bond : 35.0%","Seuil de déclenchement : 5 points"]',
    'drift', 'drift:40000000-0000-0000-0000-000000000001:bond',
    '2.00', '3.00', '0.00', '5.00', 'EUR',
    now(), now() + interval '14 days'
  ),
  (
    'b0000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000001', '<DEMO_USER_ID>', 'a0000000-0000-0000-0000-000000000001',
    'suggestion', 'HYBRID_SUGGESTIVE', 'presented',
    'rebalance', null, null, 'EUR',
    'Contexte macro : l''inflation zone euro est ressortie à +2,9 %, au-dessus des attentes. Votre exposition obligataire EUR pourrait être réévaluée.',
    '["Signal macro : inflation_data sévérité warning","Exposition obligataire EUR : 35% du portefeuille","Duration moyenne estimée : 6.5 ans"]',
    'macro_signal', 'macro:80000000-0000-0000-0000-000000000003:40000000-0000-0000-0000-000000000001',
    null, null, null, null, null,
    now() - interval '1 day', now() + interval '6 days'
  ),
  (
    'b0000000-0000-0000-0000-000000000003',
    '40000000-0000-0000-0000-000000000001', '<DEMO_USER_ID>', 'a0000000-0000-0000-0000-000000000001',
    'suggestion', 'HYBRID_SUGGESTIVE', 'presented',
    'contribute', null, '400.00', 'EUR',
    'Versement mensuel planifié pour l''objectif "Retraite" : à réaliser pour rester aligné avec le plan (400 €/mois sur 240 mois).',
    '["Objectif : Retraite — complément de revenu","Plan mensuel : 400 €","Taux de réalisation actuel : 14%"]',
    'goal_trigger', 'goal:90000000-0000-0000-0000-000000000001:monthly',
    null, null, null, null, null,
    now() - interval '2 days', now() + interval '5 days'
  ),
  (
    'b0000000-0000-0000-0000-000000000004',
    '40000000-0000-0000-0000-000000000001', '<DEMO_USER_ID>', 'a0000000-0000-0000-0000-000000000001',
    'suggestion', 'HYBRID_SUGGESTIVE', 'presented',
    'sell', 'AAPL', '1500.00', 'USD',
    'Concentration sur AAPL : la ligne représente 11 % du portefeuille, proche du cap de 30 % défini mais déjà supérieure au target 10 % de la politique single-name.',
    '["Ligne AAPL = 11% du portefeuille","Cap mandat : 30%","Cible single-name : 10%"]',
    'concentration', 'concentration:40000000-0000-0000-0000-000000000001:AAPL',
    '2.50', '5.00', '7.50', '15.00', 'EUR',
    now() - interval '3 days', now() + interval '4 days'
  )
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
