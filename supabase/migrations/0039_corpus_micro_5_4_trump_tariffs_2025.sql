-- Migration 0039 — Corpus micro 5.4 : Trump "Liberation Day" Tariffs (2 avril 2025)
--
-- Plus grande onde de choc tariff depuis Smoot-Hawley 1930. S&P 500 -20%
-- en une semaine. Revirement 9 avril (Trump pauses tariffs) = plus gros
-- rally journalier depuis 2008. Test case : politique erratique + markets.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'trump_liberation_day_tariffs_2025',
  'Trump "Liberation Day" Tariffs + Market Crash + 9-day Pause Reversal',
  'policy_shift',
  '2025-03-21',
  '2025-05-13',
  '~8 semaines : annonce 21 mars → crash 2-8 avril → pause 9 avril → recovery mai',
  'Le 21 mars 2025, Trump annonce que le 2 avril 2025 serait ''Liberation Day'' — date de l''annonce de tariffs globaux reciprocaux. Le 2 avril : Trump dévoile structure tariff avec base 10% on all imports + ''reciprocal'' additional tariffs up to 50% sur partners majeurs (Chine 54%, EU 20%, Japon 24%, Vietnam 46%, Thaïlande 37%). Les marchés réagissent violemment : S&P 500 -4.8% le 3 avril (pire depuis COVID), Nasdaq -6.0%. Le 4 avril, Chine announces retaliation (34% on US imports) → selling accelerate. S&P 500 cumulated -10.5% sur 2 séances (vendredi 4 + lundi 7 avril) — plus grosse chute 2 jours depuis 2020. Le 7 avril, ''Black Monday'' mention : S&P -5.8% intraday, recovers to -0.23%. VIX spike à 60 intraday. Le 8 avril, Trump increases China tariffs to 104%, escalation inquiète. Le 9 avril 2025 à 13h17 ET, Trump tweete : ''I have authorized a 90-day PAUSE, and a substantially lowered Reciprocal Tariff during this period, of 10%'' pour tous sauf Chine (+125% China). Marchés explosent : S&P 500 +9.5% en une séance (biggest single-day rally depuis octobre 2008), Nasdaq +12.2%, le biggest day dans 25 ans. VIX chute de 52 à 33. Pattern suivant : oscillations tariff announcements à travers avril-mai. Le 13 mai 2025, S&P 500 turns POSITIVE YTD après months of negative. Pattern : politique erratique Trump + reversal rapide = flash event court durée. Mais impacts structurels : hausse prix consumer (import inflation), entreprises revisit supply chains, accélération re-shoring. Fed complique job inflation management — pause cuts. Global tensions USD, trade war Chine-US.',

  '[
    "21 mars 2025 : Trump announce ''Liberation Day'' 2 avril for global reciprocal tariffs",
    "2 avril 2025 : Trump announce base 10% all imports + reciprocal up to 50% sur partners clés",
    "Tariffs par pays : Chine 54%, EU 20%, Japon 24%, Vietnam 46%, Thaïlande 37%, Taiwan 32%",
    "4 avril : Chine retaliation 34% US imports → sell-off accelerate",
    "S&P 500 -4.8% le 3 avril, -6.0% le 4 avril = -10.5% en 2 jours",
    "7 avril ''Black Monday'' : intraday -5.8%, close -0.23% (sur false rumor pause)",
    "8 avril : Trump hikes China tariff to 104%, puis 125%",
    "9 avril 13h17 ET : Trump pause 90 jours tariffs (sauf Chine) → markets explode",
    "9 avril S&P 500 +9.52% — biggest single-day rally depuis oct 2008 (+10.79%)",
    "9 avril Nasdaq +12.16% — biggest daily since 2001",
    "9 avril Russell 2000 +8.7%, Dow +8%",
    "VIX peak 60.13 (7 avril intraday), close 45.3",
    "13 mai 2025 : S&P 500 YTD turns positive après months negative",
    "US-China Geneva deal 12 mai 2025 : reduce tariffs temporarily",
    "$7 trillion market cap swing in 2 weeks (per S&P500)"
  ]'::jsonb,

  '[
    "Trump campaign 2024 promised tariffs 10% universal + 60% China",
    "Trump inauguration 20 janvier 2025 — immédiatement Executive Orders tariff reviews",
    "Steel + aluminum tariffs 10-25% dès février 2025",
    "Mexico + Canada tariffs 25% annoncé 1er fév, suspended 3 fév (USMCA)",
    "China tariffs incremental 10% → 20% février-mars 2025",
    "Markets complacent : VIX sub-20 début mars, SPY ATH récent",
    "Corporate earnings season Q1 positive (tech dominé)",
    "Fed hawkish pause (held 4.25-4.50% since Jan 2025)",
    "DOGE (Dept. Gov Efficiency) Elon Musk layoffs impact on consumer confidence",
    "DeepSeek R1 shock janvier 2025 (NVDA -17%) déjà testé fragility",
    "Political uncertainty : Trump congressional majority slim (House)"
  ]'::jsonb,

  '{
    "equity_us_sp500": {
      "peak_level_pre_tariff": 5670,
      "trough_level": 4900,
      "trough_date": "2025-04-07",
      "peak_drawdown_pct": -13.6,
      "april_9_single_day_pct": 9.52,
      "recovery_days_to_positive_ytd": 34,
      "notes": "S&P 500 -13.6% en 2 semaines, rally +9.5% le 9 avril (biggest day since 2008). YTD positive 13 mai."
    },
    "equity_nasdaq": {
      "peak_drawdown_pct": -17.5,
      "april_9_rally_pct": 12.16,
      "notes": "Nasdaq plus hit (tech/import-dependent) mais bigger rebound"
    },
    "equity_russell_2000": {
      "peak_drawdown_pct": -18,
      "april_9_rally_pct": 8.7,
      "notes": "Small caps particularly exposed à tariffs (domestique mais supply chains)"
    },
    "vix": {
      "pre_event_level": 19.5,
      "intraday_peak": 60.13,
      "peak_date": "2025-04-07",
      "close_level_april_7": 46.98,
      "2week_later": 25,
      "notes": "VIX 60 intraday 7 avril = 4ème plus haut histoire. Rapid mean revert post-pause"
    },
    "govt_bonds_us_10y": {
      "pre_event_yield_pct": 4.25,
      "crisis_low_pct": 3.86,
      "post_pause_yield_pct": 4.48,
      "notes": "10y yield dual dynamic : initial flight-to-quality (yields down), puis spike sur tariff inflation fears (yields up post-pause)"
    },
    "fx_dxy": {
      "pre_event_level": 104.2,
      "crisis_low_level": 98.2,
      "move_pct": -5.7,
      "notes": "DXY SURPRISINGLY drops during tariff crisis — ''sell America'' trade, foreign capital outflows, confidence shake"
    },
    "fx_eurusd": {
      "pre_event_level": 1.09,
      "peak_level": 1.155,
      "notes": "EUR/USD rallies strongly as dollar weakens. Paradox : tariffs should strengthen USD but political uncertainty + outflows dominated"
    },
    "commodities_gold": {
      "pre_event_level_usd": 3050,
      "peak_level_usd": 3330,
      "ath_during_crisis": true,
      "notes": "Gold hits ATH $3300+ during crisis — safe haven flight. Gold continues rally to $4000+ through 2025"
    },
    "bitcoin": {
      "pre_event_level_usd": 87000,
      "trough_usd": 75000,
      "recovery_date": "2025-05-01",
      "drawdown_pct": -14,
      "notes": "BTC impacted mais less than equity — ''digital gold'' narrative supported some bid"
    },
    "tech_mega_caps_impact": {
      "apple_3day_drop_pct": -19,
      "nvidia_3day_drop_pct": -14,
      "tesla_3day_drop_pct": -20,
      "notes": "Tech hit hard by China tariffs (supply chains, demand), especially AAPL (China manufacturing)"
    },
    "retail_sector_impact": {
      "target_drop_pct": -16,
      "kohls_drop_pct": -22,
      "nike_drop_pct": -15,
      "notes": "Import-heavy retailers devastated — tariffs direct COGS hit"
    },
    "us_treasuries_30y_auction": {
      "date": "2025-04-10",
      "bid_to_cover": 2.39,
      "foreign_demand_pct": 65,
      "notes": "30y auction 10 avril important test — foreign demand holds despite political turmoil"
    }
  }'::jsonb,

  '{
    "before": "Globalization stable narrative, Trump tariff threats perceived as negotiating tactic, markets complacent (VIX <20), corporate supply chains status quo, dollar unchallenged reserve.",
    "after": "Tariff uncertainty becomes permanent macro variable. Corporate supply chain diversification accelerated (re-shoring, nearshoring). Some inflation supply shock persistence. Foreign confidence US assets shaken (DXY drops during crisis = unusual). China relationship redefined. Fed rate path delayed by inflation uncertainty. Selected sectors durably impacted : import-heavy retail, Chinese-exposed tech."
  }'::jsonb,

  'Pause 90 jours expire 9 juillet 2025. Trump reverts to tariff threats periodically mais moins extreme. US-China deal Geneva mai + London june 2025 : partial tariff reduction. Sectoral tariffs continue (steel, aluminum, auto). Inflation resurgence modérée Q2 2025 (import prices). Fed delays cuts until Q4 2025 (originally expected mid-2025). Supply chain rewiring : Mexico, Vietnam, India benefit. Corporate Q2 earnings weaker due to tariff costs + weaker consumer. 2026 outlook uncertain : nouvelles escalations possibles selon political cycle.',

  '[
    "Policy Trump = flash events with rapid reversals — tradable patterns",
    "Single tweet announce peut mover $7T in 2 weeks — asymmetric policy impact",
    "Reversal (9 avril pause) peut être aussi explosif que crash — biggest single-day rally depuis 2008",
    "Tariffs are inflationary supply shock → Fed cuts path reconsidered",
    "DXY dropping during US policy crisis = unusual (traditionally flight-to-dollar) → ''sell America'' dynamic when policy erratic",
    "Foreign demand US Treasuries robust despite political volatility → USD hegemony structural",
    "Tech mega-caps vulnerable to China exposure (AAPL) → diversification narrative",
    "Small caps more exposed to tariffs (R2K -18%) vs large caps (more international)",
    "Gold ATH during US policy crisis = safe haven flight institutional",
    "BTC performs RELATIVELY well in USD crisis — ''digital gold'' thesis tested positive",
    "Market pricing-in pattern : consensus underestimated Trump willingness to follow through on campaign promises",
    "Flash policy crises (2025 tariffs, 2022 Truss mini-budget, 2020 COVID) similar microstructure : sudden policy shock → forced liquidations → V-shape recovery"
  ]'::jsonb,

  '[
    "Trump admin unpredictability = structural feature 2025-2029 — futures episodes likely",
    "Tariff playbook known now → initial shock could be less severe future events",
    "Corporate supply chains adjusting → tariff impact dampened over time",
    "But structural tariff regime 10%+ baseline likely permanent",
    "US-China relationship fundamentally altered — no return to pre-2018 integration",
    "Fed path permanently complicated by inflation tariff-sourced",
    "''Sell America'' dynamic concerning : if repeated, could accelerate de-dollarization narratives",
    "Global portfolio rebalancing away from US assets incremental"
  ]'::jsonb,

  array['policy_shift','trade_war','tariff_shock','political_uncertainty','flash_crash','flash_rally','dxy_paradox','safe_haven_gold','supply_chain_shock','import_inflation','trump_era']::text[],

  'critical',
  'excellent',

  '[
    {"type":"press_release","title":"Liberation Day Executive Order","publisher":"The White House","year":2025},
    {"type":"article","title":"Trump Pauses Tariffs: Market Reaction","publisher":"Wall Street Journal","year":2025},
    {"type":"paper","title":"The Economic Impact of Trump''s Tariffs","publisher":"Peterson Institute","year":2025},
    {"type":"data","title":"CBOE VIX historical data, April 2025","publisher":"CBOE"},
    {"type":"report","title":"2025 Tariff Impact on Global Trade","publisher":"WTO","year":2025},
    {"type":"article","title":"The Biggest S&P 500 Rally Since 2008","publisher":"Bloomberg","year":2025}
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
