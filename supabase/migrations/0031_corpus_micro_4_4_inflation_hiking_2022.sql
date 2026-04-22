-- Migration 0031 — Corpus micro 4.4/6 : Inflation Surge + Fed Hiking 2022
--
-- Plus grand choc inflationniste depuis Volcker. CPI US 1.4% → 9.1% en
-- 17 mois. Fed force 425bps de hikes en 9 mois (fastest depuis 1980).
-- 60/40 pire année jamais. Gilt UK crisis (septembre 2022). JPY -20%.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'inflation_surge_fed_hiking_2021_2022',
  'Inflation Surge + Fed Fastest Hiking Cycle since Volcker',
  'inflation_shock',
  '2021-04-01',
  '2022-12-14',
  '~20 mois de l''accélération inflation (Q2 2021) au peak hike Fed 4.50% (déc 2022)',
  'L''inflation US commence à accélérer en Q2 2021 : CPI 4.2% en avril (vs 2.6% en mars), Fed qualifie de ''transitoire'' (Powell + Yellen mantra). En juin 2022, CPI culmine à 9.1% YoY — plus haut depuis 1981. Core CPI peak 6.6% (septembre 2022). Drivers : (1) supply chain disruption COVID (containers, semi-conducteurs), (2) stimulus massif 2020-2021 (M2 +40% en 18 mois), (3) Russia invasion Ukraine février 2022 (commodities spike, voir micro 4.5), (4) labor market tight (JOLTS 11M openings record), (5) shelter inflation lag effect. Fed reconnaît erreur ''transitoire'' en novembre 2021 (Powell retirement discours). Premier hike mars 2022 (+25bps après 3 ans à 0). Cycle le plus rapide depuis Volcker : 4 hausses consécutives de 75bps (juin, juillet, septembre, novembre 2022) + 50bps décembre. Fed funds : 0-0.25% → 4.25-4.50% en 9 mois (+425bps). US 10y Treasury : 1.5% → 4.25% (octobre 2022). S&P 500 -25% peak to trough. NASDAQ -35% (sensibilité duration). 60/40 portfolio -17% (pire année jamais — bonds ET stocks down simultanément). USD DXY 95 → 114 (septembre 2022) — 20-year high. Conséquences globales : (a) UK Liz Truss ''mini-budget'' 23 sept 2022 → gilt yields spike 100bps en 2 jours, LDI pension funds forced selling, BoE emergency intervention, £ crash à parité USD ; (b) BoE + BCE forcés à hiker dans récession ; (c) BoJ résiste (YCC maintain), JPY crash à 150 (32 ans low) ; (d) EM FX crisis (EGP, ARS, TRY effondrent) ; (e) crypto winter (voir micro 4.6).',

  '[
    "M2 money supply +40% de fév 2020 à avril 2021 — expansion monétaire unprecedented",
    "CPI US pic 9.1% juin 2022 — highest depuis 1981 (fin de l''ère Volcker)",
    "Core CPI pic 6.6% septembre 2022 — sticky inflation hors food/energy",
    "Fed hike cycle : +25bps mars + 50bps mai + 75bps juin/juillet/septembre/novembre + 50bps décembre = 425bps en 9 mois",
    "Jackson Hole 26 août 2022 Powell speech 8 minutes — hawkish pivot confirmé : ''we must keep at it''",
    "US 10y Treasury yield peak 4.25% (octobre 2022) — depuis 2007",
    "USD DXY peak 114.78 (28 sept 2022) — 20-year high",
    "UK gilt crisis 23-28 septembre 2022 : Liz Truss mini-budget, gilt 30y +130bps en 3 jours, BoE 65 Md£ intervention",
    "GBP/USD touche 1.0350 (quasi-parité) 26 septembre 2022 — all-time intraday low",
    "BCE first hike juillet 2022 +50bps (depuis -0.5%), +300bps by Q4 2022",
    "BoJ résiste avec YCC, JPY/USD de 114 (jan 2022) à 150 (octobre 2022) = -24%",
    "60/40 portfolio 2022 : stocks -18%, bonds -13%, combined -17% — pire année depuis 1937",
    "EM FX devastated : EGP -50%, TRY -30%, ARS -53% (2022)"
  ]'::jsonb,

  '[
    "Fed QE infinity mars 2020 → bilan 4T → 9T en 2 ans",
    "CARES Act 2.2T + American Rescue Plan 1.9T + Infrastructure 1.2T + CHIPS Act 280B = 5.5T fiscal stimulus",
    "COVID supply chain disruptions 2020-2021 : semi-conducteurs, logistics, containers",
    "Russia Ukraine war 24 février 2022 → énergie + grains spike (voir micro 4.5)",
    "Labor market tight : JOLTS 11M+ openings 2021-2022 (2x historical avg)",
    "Real rates extrêmement négatifs 2021 (10y TIPS -1%) → positioning long duration massif",
    "Breakeven inflation 5y5y forward déjà >2.8% mi-2021 — signal que marché pricait pas ''transitory''",
    "ISM prices paid 85+ (Q2 2021) — signal avancé inflation qui n''a pas été pris au sérieux",
    "Fed dot plot février 2022 prévoyait 3 hikes totaux 2022 — finit à 7 hikes"
  ]'::jsonb,

  '{
    "us_cpi_inflation": {
      "pre_event_yoy_pct": 1.4,
      "pre_event_date": "2021-01",
      "peak_yoy_pct": 9.1,
      "peak_date": "2022-06",
      "core_peak_yoy_pct": 6.6,
      "core_peak_date": "2022-09",
      "notes": "De 1.4% (jan 2021) à 9.1% (juin 2022). Highest depuis 1981. Core CPI sticky plus longtemps."
    },
    "fed_funds_rate": {
      "pre_event_range": "0-0.25",
      "peak_range": "4.25-4.50",
      "peak_date": "2022-12-14",
      "hikes_total_bps": 425,
      "duration_months": 9,
      "notes": "Plus rapide cycle depuis Volcker 1979-1982. 4 consecutive 75bps hikes (record)"
    },
    "govt_bonds_us_10y": {
      "pre_event_yield_pct": 1.51,
      "peak_yield_pct": 4.25,
      "peak_date": "2022-10-21",
      "yield_move_bps": 274,
      "notes": "Plus grand move 12m depuis 1994 (Greenspan hikes). Destruction capital bondholders"
    },
    "equity_us_large_sp500": {
      "peak_level": 4796.56,
      "peak_date": "2022-01-03",
      "trough_level": 3491.58,
      "trough_date": "2022-10-13",
      "peak_drawdown_pct": -25.4,
      "duration_to_trough_days": 283,
      "notes": "Bear market slow grinding. Duration longue mais intensité modérée. Peak-to-trough 9 mois."
    },
    "equity_nasdaq": {
      "peak_drawdown_pct": -35.0,
      "mega_cap_tech_performance": "Meta -64%, Amazon -50%, Tesla -65%, Netflix -51%",
      "notes": "Duration-sensitive tech / growth most hit. Sensibilité taux"
    },
    "portfolio_60_40": {
      "2022_return_pct": -17.0,
      "stocks_contribution_pct": -18.0,
      "bonds_contribution_pct": -13.0,
      "notes": "Pire année 60/40 depuis 1937 (-21%). Corrélation stocks-bonds devenue positive"
    },
    "fx_dxy": {
      "pre_event_level": 95.5,
      "peak_level": 114.78,
      "peak_date": "2022-09-28",
      "move_pct": 20.2,
      "notes": "DXY 20-year high. EUR sous parité (0.95), GBP touch 1.035, JPY 150"
    },
    "fx_gbpusd_gilt_crisis": {
      "pre_truss_level": 1.13,
      "post_truss_intraday_low": 1.0350,
      "post_truss_date": "2022-09-26",
      "notes": "UK Liz Truss mini-budget 23 sept → GBP near parity USD premier fois depuis 1985"
    },
    "uk_gilt_30y": {
      "pre_truss_yield_pct": 3.85,
      "peak_yield_pct": 5.12,
      "peak_date": "2022-09-28",
      "yield_move_bps_3days": 127,
      "notes": "UK 30y gilt yield +127bps en 3 jours post-Truss. LDI pension funds margin calls. BoE intervention 28 sept."
    },
    "fx_usdjpy": {
      "pre_event_level": 114.2,
      "peak_level": 150.5,
      "peak_date": "2022-10-21",
      "move_pct": 31.8,
      "notes": "JPY crash — BoJ keeps YCC + negative rates pendant que Fed hike. MOF intervention 22 sept 2022 (~20 Md$)."
    },
    "bitcoin": {
      "peak_level_usd": 69000,
      "peak_date": "2021-11-10",
      "trough_level_usd": 15500,
      "trough_date": "2022-11-21",
      "peak_drawdown_pct": -77.5,
      "notes": "BTC -77% du peak 2021 au trough 2022. Corrélation risk-on MAX à ce moment."
    },
    "real_estate_us_commercial": {
      "peak_drawdown_pct": -20.0,
      "notes": "Commercial real estate cap rates expansion massive, transactions -60% 2022 vs 2021"
    },
    "em_fx_worst": {
      "egyptian_pound_egp_pct": -50.0,
      "turkish_lira_try_pct": -30.0,
      "argentine_peso_ars_pct": -53.0,
      "notes": "Fragile-Five 2013 pattern revient — mais c''est les ''Fragile Emerging'' 2022"
    }
  }'::jsonb,

  '{
    "before": "Régime ''lower for longer'' inflation 1.5-2%, Fed dovish, ZIRP + QE, 60/40 portfolio reliable (negative stock-bond correlation).",
    "after": "Régime inflation 3-4%+ stickier, Fed hawkish limité sur accommodation future, rates higher for longer (5%+ Fed funds), 60/40 challenged (stock-bond correlation positive). Liquidity systémique moins abondante. Real rates positifs for first time since 2008."
  }'::jsonb,

  'CPI commence à décliner du peak 9.1% : 8.5% juillet, 8.3% août, 8.2% septembre, 7.7% octobre, 7.1% novembre, 6.5% décembre 2022. Fed continue hikes en 2023 : +25bps fév, mars, mai, juillet 2023 = peak 5.25-5.50%. Core inflation sticky jusqu''à mi-2023. Fed commence cutting cycle septembre 2024 (-50bps, voir micro 5.x). Récession tant attendue n''arrive jamais en 2023 ("soft landing"). 60/40 repart en 2023-2024.',

  '[
    "L''inflation a 12-24 mois de lag par rapport à la monetary expansion — M2 +40% 2020-21 a donné CPI 9% 2022",
    "''Transitory'' était conceptuellement défendable mais politiquement désastreux comme narrative — a discrédité la Fed pour années",
    "La Fed peut hiker agressivement sans casser l''economie SI emploi reste solide — ''soft landing'' possible (2022-2024 validé)",
    "Stock-bond correlation devient POSITIVE en régime inflation — 60/40 n''est plus un hedge parfait",
    "Duration risk (obligations longues) tue plus que équity risk en cycle hausse taux — TLT -50% en 2 ans",
    "USD bénéficie massivement de Fed hawkish vs autres banques centrales — DXY 114 en 2022",
    "Les pays qui résistent (Japon YCC) subissent crash FX — BoJ forcée d''intervenir",
    "Leveraged investors (UK pensions LDI, crypto natives, tech VCs) sont ceux qui break FIRST",
    "Les tech / growth stocks / long duration assets sous-performent dramatiquement en hike cycle — sensibilité mathématique",
    "Real rates positifs attaquent les actifs sans cash-flow (or, crypto, unprofitable tech)",
    "EM vulnérables sont les mêmes cycles après cycles (TRY, ARS, EGP) — structurel, pas cyclique",
    "Les banques centrales ne peuvent pas contrôler à la fois inflation, emploi, ET stabilité financière — trilemma"
  ]'::jsonb,

  '[
    "Chaque cycle inflation a ses causes uniques — 2022 cumul supply shock + fiscal + monetary, pas reproductible simple",
    "La Fed a appris : next inflation surge sera traitée plus vite (moins de ''transitoire'')",
    "Post-2022, positioning beaucoup plus prudent sur duration — moins de vulnerability massive aux prochains hikes",
    "Le YCC japonais a été assoupli avril 2024 — pattern 2022 ne se reproduira pas à l''identique",
    "Corrélation stocks-bonds peut redevenir négative si inflation retourne structurellement <2.5%",
    "La contrainte politique sur le déficit US limite la fiscale-expansion pour la prochaine crise",
    "CRE commercial real estate continue à se de-lever en 2024-2025 — legacy 2022",
    "Régime inflation 3% sticky peut être le nouveau normal (vs 2% target) — implications valuation durables"
  ]'::jsonb,

  array['inflation_shock','fed_hawkish','rate_hike_cycle','60_40_failure','duration_destruction','dxy_spike','gilt_crisis','ldi_crisis','yen_carry_trade','em_fx_crisis','soft_landing','policy_mistake_transitory']::text[],

  'critical',
  'excellent',

  '[
    {"type":"speech","title":"Monetary Policy and Price Stability (Jackson Hole)","authors":"Jerome Powell","year":2022,"publisher":"Federal Reserve"},
    {"type":"paper","title":"The Global Inflation Surge of 2021-2022","authors":"IMF WEO","year":2022},
    {"type":"paper","title":"The UK gilt market crisis of 2022","authors":"BIS Working Paper","year":2023},
    {"type":"book","title":"The Price of Time","authors":"Edward Chancellor","year":2022,"publisher":"Grove Atlantic"},
    {"type":"data","title":"FRED CPI, Core CPI, Fed Funds","publisher":"St. Louis Fed"},
    {"type":"paper","title":"The Fastest Rate-Hiking Cycle Since Volcker","authors":"Goldman Sachs Research","year":2022}
  ]'::jsonb
)
on conflict (slug) do update set
  title=excluded.title, category=excluded.category, date_start=excluded.date_start,
  date_end=excluded.date_end, duration_description=excluded.duration_description,
  context_description=excluded.context_description, key_drivers=excluded.key_drivers,
  preconditions=excluded.preconditions,
  market_impact_by_asset_class=excluded.market_impact_by_asset_class,
  regime_shift=excluded.regime_shift, resolution=excluded.resolution,
  lessons_learned=excluded.lessons_learned,
  limitations_of_comparison=excluded.limitations_of_comparison,
  similar_setups_tags=excluded.similar_setups_tags,
  severity_at_peak=excluded.severity_at_peak, data_quality=excluded.data_quality,
  references=excluded.source_references, updated_at=now();
