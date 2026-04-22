-- Migration 0041 — Corpus micro 5.6 : Gold $5000 + BRICS De-Dollarization (2024-2026)
--
-- Or pulvérise records historiques : $2000 (2020), $3000 (mars 2025),
-- $4000 (sept 2025), $5000+ (2026). Central banks achètent 1000-1200
-- tonnes/an depuis 2022. BRICS launch ''Unit'' gold-backed pilot oct 2025.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'gold_5000_brics_dedollarization_2024_2026',
  'Gold breaks $5000 + BRICS De-Dollarization Acceleration',
  'policy_shift',
  '2023-10-01',
  '2026-12-31',
  '~3 ans de structural rally gold $1900 → $5000+',
  'L''or a pulvérisé records historiques 2023-2026 dans un rally structurel sans précédent moderne. Starting $1920 (octobre 2023), gold traverse : $2000 (février 2024), $2500 (août 2024), $3000 (mars 2025, historic), $4000 (septembre 2025), $5000+ (octobre 2026) = +160% en 3 ans. Drivers multiples et convergents : (1) Central banks emerging markets achats unprecedented : 1136t (2022), 1037t (2023), 1045t (2024), 1200t (2025 estimated). Chine PBOC accumule 280t+ depuis 2022 (officially reported, unofficial possibly much higher). Poland, Turkey, India, Singapore top buyers. (2) De-dollarization BRICS post-sanctions Russie 2022 : gel 300 Md$ Russian CB reserves = risk awareness for all EM central banks. BRICS+ expansion 2024 (Iran, UAE, Egypt, Ethiopia, Saudi — later retracted). BRICS Summit Kazan octobre 2024 : push dollar alternative settlements. BRICS Summit Rio juillet 2025 : gold-backed settlement framework discussed. (3) US debt trajectory : $35T (2024), $40T+ (2026 projected), 6%+ deficits structural, interest expense > defense spending 2024 = ''fiscal dominance'' concerns. (4) Real rates compression : Fed cuts September 2024 (-50bps), further 25bps November + December → real rates neutral/negative favor gold. (5) Geopolitics : Iran war 2026, Israel-Gaza continuing, Ukraine prolonged, Taiwan tensions, US political polarization. (6) Inflation persistence 2.5-3.5% (above 2% target) → gold hedge. (7) BRICS ''Unit'' gold-backed currency pilot launched 31 octobre 2025 : instrument pegged 1 gram gold + 40/60 mix physical gold and BRICS national currencies. (8) Institutional adoption : Gold ETFs holdings récupèrent après 2022 outflows, records highs 2025. (9) Retail adoption : physical gold demand India + China record. Silver follows but with amplified volatility. Gold mining stocks underperform bullion price (operational cost inflation, ESG constraints).',

  '[
    "Gold price trajectory : $1920 (oct 2023) → $2000 (fév 2024) → $3000 (mars 2025) → $4000 (sept 2025) → $5000+ (2026)",
    "Central banks gold purchases unprecedented : 1136t (2022), 1037t (2023), 1045t (2024), 1200t (2025)",
    "China PBOC accumulates 280+ tonnes since 2022 (officially reported)",
    "Turkey, Poland, India, Singapore top buyers 2023-2025",
    "Russian CB reserves freeze March 2022 (300 Md$) = paradigm shift for EM reserves management",
    "BRICS+ expansion 2024 : Iran, UAE, Egypt, Ethiopia join (Saudi later delays)",
    "BRICS Kazan Summit October 2024 : de-dollarization discussions accelerated",
    "BRICS Rio Summit July 2025 : gold-backed settlement framework proposed",
    "BRICS ''Unit'' pilot launch 31 octobre 2025 : 1 gram gold peg + 40/60 mix",
    "US debt : $34T (Jan 2024) → $36T (Dec 2024) → $40T (forecast 2026)",
    "US interest expense > defense spending 2024 (first time peacetime)",
    "Fed cuts September 2024 (-50bps) + 25bps x2 → 4.25-4.50%",
    "US persistent deficits 6-7% GDP — fiscal dominance concerns",
    "J.P. Morgan forecasts gold $5055/oz Q4 2026, $5400/oz end 2027"
  ]'::jsonb,

  '[
    "Russian CB reserves freeze March 2022 (300 Md$) — paradigm shock for EM central banks",
    "China reducing US Treasuries holdings : $1.3T (2014) → $760Md (2024) + shift to gold",
    "India reducing Treasuries, accumulating gold (RBI 2-3t monthly 2023-2024)",
    "Saudi Arabia + GCC discussing yuan oil payments (petroyuan) 2022-2024",
    "Post-COVID inflation persists (CPI sticky 3-3.5%) despite Fed hikes",
    "Fed balance sheet $9T peak 2022 → $7T via QT 2023-2025",
    "Geopolitical tensions : Russia-Ukraine prolonged, Israel-Hamas since October 2023",
    "Iran tensions escalate 2024-2026 (see micro 5.7)",
    "US political uncertainty (Trump admin 2025, DOGE, tariffs crisis April 2025)",
    "Real yields 10y TIPS stable positive 2024-2025 mais bas (1.5-2%)",
    "Paper gold derivatives (futures, ETFs) + physical decoupling stress signals 2024-2025"
  ]'::jsonb,

  '{
    "gold_price_trajectory": {
      "october_2023_usd": 1920,
      "feb_2024_2000_breakthrough": "2024-02-29",
      "mar_2025_3000_breakthrough": "2025-03-14",
      "sept_2025_4000_breakthrough": "2025-09-15",
      "oct_2026_5000_breakthrough": "2026-04-15",
      "peak_2026_usd": 5100,
      "return_3years_pct": 165,
      "notes": "Gold +165% en 3 ans. Pattern : breakouts à $2000, $3000, $4000, $5000 chacun accompagné de volume surge + volatility spike"
    },
    "central_bank_gold_buying": {
      "tonnes_2022": 1136,
      "tonnes_2023": 1037,
      "tonnes_2024": 1045,
      "tonnes_2025_est": 1200,
      "3year_total_tonnes": 4418,
      "previous_decade_annual_avg_tonnes": 400,
      "notes": "1000+ tonnes/year = 2.5x historical average. Structural buying, not episodic"
    },
    "top_central_bank_buyers_2025": {
      "china_pbsc_tonnes": 220,
      "poland_nbp_tonnes": 120,
      "turkey_tonnes": 100,
      "india_rbi_tonnes": 80,
      "singapore_tonnes": 60,
      "notes": "China possibly much more — unofficial channels ( PBoC discount)"
    },
    "silver_price": {
      "october_2023_usd": 22,
      "peak_2026_usd": 68,
      "return_pct": 209,
      "notes": "Silver amplifie gold — typically 2x gold volatility both ways"
    },
    "gold_mining_stocks": {
      "gdx_gold_miners_etf_return_pct": 110,
      "newmont_nem_return_pct": 90,
      "barrick_gold_gold_return_pct": 85,
      "notes": "Miners sous-performent bullion (2-3x underperformance historically expected, seulement 0.7x ici) — opex inflation + ESG capex"
    },
    "gold_etfs_flows": {
      "2022_outflows_tonnes": -110,
      "2023_outflows_tonnes": -244,
      "2024_inflows_tonnes": 120,
      "2025_inflows_tonnes": 350,
      "notes": "ETFs flows lag physical demand — institutional catch-up 2024-2025"
    },
    "usd_dxy": {
      "october_2023": 106,
      "2025_range": "100-110",
      "2026_range": "95-105",
      "notes": "DXY relatively stable despite gold rally — gold rallies beyond dollar move (real value thesis)"
    },
    "us_treasuries_10y": {
      "gold_rally_period_yields_range": "3.8-4.8",
      "notes": "10y yields elevated vs historical but gold rallies anyway — real rates + fiscal concerns dominant"
    },
    "brics_unit_currency_pilot": {
      "launch_date": "2025-10-31",
      "peg_structure": "1 gram gold + 40/60 physical gold + BRICS currencies basket",
      "pilot_volume_usd_bn_2025": 50,
      "notes": "Pilot program for BRICS trade settlements. Limited volumes but symbolic shift."
    },
    "petroyuan_trends": {
      "saudi_yuan_oil_sales_2024_pct": 5,
      "iran_china_oil_yuan_pct": 90,
      "russia_china_yuan_settlements_pct": 70,
      "notes": "Yuan gaining share oil trade settlements — still small vs USD but growing"
    }
  }'::jsonb,

  '{
    "before": "USD reserve hegemony undisputed (59% global reserves), Treasuries primary sovereign safe asset, gold allocation minor (~10% central bank reserves), BRICS nominal organization without alternative currency infrastructure.",
    "after": "USD reserve share declining (59% → 53% during period), gold allocation rising (10% → 17% central banks), BRICS infrastructure for alternative settlements emerging (gradually). De-dollarization partial but structural. Fiscal dominance concerns structural in US. Gold as ''anti-fiat'' insurance premium embedded in valuations. Multi-polar reserve currency world emerging (USD, EUR, JPY, CNY, gold)."
  }'::jsonb,

  'Gold continues elevated trajectory 2026+ mais normalizes growth rate. J.P. Morgan forecasts $5055 Q4 2026, $5400 fin 2027. BRICS ''Unit'' pilot expand 2026. Yuan internationalization continue. US fiscal path critical : si Trump admin reduces deficits modest, gold could consolidate. If fiscal expansion continues, higher. Central bank buying continues mais potentiellement slower rate as positions mature. Mining sector capex responses create supply 2027-2030. Silver gap closes. Risks gold : (1) Fed hawkish surprise, (2) tech crypto substitution (BTC taking share), (3) monetary breakthrough (stablecoins, CBDCs). But structural tailwinds persistent.',

  '[
    "Central banks ne mentent pas avec leurs achats — 1000t/year = tectonic shift, pas trade cyclique",
    "Sanctions weaponization USD/Treasuries (2022 Russia freeze) = paradigm shock for EM central banks",
    "Fiscal dominance narrative : si deficits persistent + interest expense > defense → gold wins structurally",
    "De-dollarization ne nécessite pas remplacement complet USD — share decline from 60% to 50% = massive gold implications",
    "BRICS infrastructure takes decades mais progresses — Unit pilot 2025 = first concrete step",
    "Petroyuan : 5% Saudi oil in yuan = small mais symbolically crucial — crack dans petrodollar",
    "Gold miners under-perform bullion structurally — operational cost inflation, ESG constraints, labor scarcity",
    "Silver has gold beta 2x + industrial component (solar, EVs, semiconductors) = upside amplification",
    "ETF flows lag physical demand by 12-24 months — institutional wake-up time",
    "Real rates + fiscal + geopolitics triad = gold bullish regime (2023-2026 confirms)",
    "Gold at ATH during Fed cuts = rare regime (normally cuts = risk-on = gold could mean-revert)",
    "Crypto BTC complementary not substitutive to gold — both benefit fiat concerns",
    "Breakouts at round numbers ($2000, $3000, $4000) = technical support + FOMO buying"
  ]'::jsonb,

  '[
    "Central bank buying pourrait slow si reserves reach ''target allocation''",
    "Rapid hike cycle could temporarily pressure gold (mais 2022 showed resilience)",
    "If Trump admin achieves fiscal discipline (unlikely but possible), gold thesis weakens",
    "BTC/crypto substitution risk : if institutional BTC allocation grows, gold share compressed",
    "CBDCs + stablecoins could provide alternative ''digital cash'' reducing gold appeal",
    "Tech innovation monetary (FedNow + digital USD) could restore USD strength",
    "Conflict resolution Russia-Ukraine or Middle East could reduce geopolitical premium",
    "But : 3+ year structural rally suggests paradigm shift, not cyclical top"
  ]'::jsonb,

  array['policy_shift','gold_rally','central_bank_buying','de_dollarization','brics','fiscal_dominance','petroyuan','currency_regime_shift','safe_haven_structural','reserve_currency_diversification','sanctions_aftermath']::text[],

  'watch',
  'excellent',

  '[
    {"type":"report","title":"Gold Demand Trends","publisher":"World Gold Council","year":2024},
    {"type":"paper","title":"De-Dollarization: The End of Dollar Dominance?","authors":"IMF Working Paper","year":2024},
    {"type":"report","title":"Central Bank Gold Reserves Survey","publisher":"World Gold Council","year":2025},
    {"type":"report","title":"Gold Outlook Update","publisher":"J.P. Morgan Global Research","year":2025},
    {"type":"article","title":"BRICS Unit Currency Launch","publisher":"Financial Times","year":2025},
    {"type":"data","title":"IMF COFER Database (reserve composition)","publisher":"IMF"},
    {"type":"paper","title":"The Future of the International Monetary System","authors":"Eichengreen, Mehl, Chitu","year":2024}
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
