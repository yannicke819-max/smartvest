-- Migration 0027 — Corpus micro 3.5/5 : Volmageddon + Fed Pivot (2018-2019)
--
-- Année 2018 cumule 2 événements enseignants : (1) Volmageddon 5 février
-- 2018 — XIV (short-vol ETN) wiped out à cause d''un VIX +115% un jour ;
-- (2) Q4 2018 S&P -20% avec Fed pivot dovish Powell 19 déc puis 4 janvier.
-- Les DEUX montrent comment positioning accumulé (short vol, long duration
-- de hausses Fed) peut se retourner violemment.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'volmageddon_and_fed_pivot_2018_2019',
  'Volmageddon (Feb 2018) + Q4 2018 Bear + Powell Pivot (Jan 2019)',
  'market_stress',
  '2018-02-05',
  '2019-01-04',
  '11 mois incluant 2 épisodes distincts : Volmageddon fev 2018 + Q4 bear + pivot Powell',
  'Deux événements clés de 2018-2019 qui ensemble illustrent l''importance du positioning et de la communication Fed. (1) VOLMAGEDDON 5 février 2018 : le VIX passe de 17 à 37 (+115%) en une journée, le plus gros move VIX jamais. Les produits short-vol (XIV de Credit Suisse, SVXY) conçus pour INVERSER la performance du VIX explosent : XIV perd -96% en after-hours, is terminé le 6 février (stop-loss à -80% déclenché). Les ''vol sellers'' structurels étaient devenus systémiques (estimated 2-4 T$ notional short vol). Leur deleveraging amplifie le mouvement. S&P 500 perd -10% sur la semaine. (2) Q4 2018 BEAR : à partir de septembre, Fed sous Powell remonte les taux, promet 2 hikes en 2019 ( supplier dot plot), annonce QT en ''autopilot''. Market digère mal : S&P 500 -20% du peak (3 oct) au trough (24 déc 2018). Apple -38%, NVDA -56%, semis en crash. Treasuries rally modeste. VIX 36. 24 déc 2018 = pire Christmas Eve de l''histoire pour S&P. Mnuchin appelle les CEO banques (''Plunge Protection Team''). (3) PIVOT POWELL 4 janvier 2019 (Atlanta AEA conference, panel avec Bernanke et Yellen) : Powell déclare ''patience'' sur les hikes, mentionne flexibilité sur QT. Marchés rallient instantanément. S&P 500 +43% sur 10 mois suivants. Fed finira par CUTTER 3 fois en 2019 (''insurance cuts''). Leçon : tout biais accumulé de positioning peut se purger violemment, et la communication Fed est devenue un outil de stabilisation à elle seule.',

  '[
    "VIX +115% le 5 fév 2018 — plus grand daily move VIX jamais",
    "XIV (Credit Suisse short-vol ETN) terminé le 6 fév — 2 Md$ AUM wiped out, investors lose 96%",
    "SVXY (ProShares short-vol ETF) -88% en 2 jours",
    "Short-vol industry estimated 2-4 T$ notional positioning avant Volmageddon — overcrowded trade",
    "NFP 2 fév 2018 : wages +2.9% YoY (+0.4 bp) → inflation fear → taux longs spike",
    "Fed Powell 4 hikes 2018 (mars, juin, sept, déc) → dot plot montre 2 hikes en 2019",
    "Fed QT ''autopilot'' annoncé par Powell (11 déc 2018) — $50 Md/mois",
    "Trade war US-China escalating : tariffs 10% sur 200 Md$ (sept 2018), menace 25% (fin 2018)",
    "Apple profit warning 2 janvier 2019 (Chine demand weakness) → -10% ce jour — catalyseur intermédiaire",
    "Powell ''patience'' speech 4 janvier 2019 Atlanta — pivot officiel",
    "Fed minutes janvier 2019 confirment pause, discussion QT end"
  ]'::jsonb,

  '[
    "Long bull market sans correction majeure depuis 2016 → complacency maximale",
    "Inflation core PCE approchait target 2% fin 2017 → Fed justifie hiking path",
    "Labor market tight : unemployment 3.7% (oct 2018) — Phillips curve concerns",
    "Positioning VIX futures record short (speculators net short 170k contracts avant Volmageddon)",
    "Short-vol ETNs AUM $3+ Md (XIV, SVXY, UVXY etc.) — industrie massive",
    "Vol term structure contango steepest décennie → incentive monetization short-vol strats",
    "Q4 2018 : 2y10y spread compressé à 15bps (vs +35bps début année) — courbe flattens",
    "Earnings révisions 2019 downward dès octobre 2018"
  ]'::jsonb,

  '{
    "vmageddon_5_fev_2018": {
      "vix_daily_move_pct": 115.6,
      "vix_open_level": 17.31,
      "vix_close_level": 37.32,
      "notes": "Record absolu daily move VIX. Close jamais vu en bull market context"
    },
    "xiv_credit_suisse": {
      "terminal_date": "2018-02-20",
      "return_before_termination_pct": -96.3,
      "aum_wiped_usd_mn": 1900,
      "notes": "XIV ETN terminated after-hours 5 fév (trigger at -80% NAV). Investors get residual ~$4/share (peak $144)"
    },
    "svxy_proshares": {
      "return_2days_pct": -88.0,
      "post_event_structure": "Reformed as 0.5x short-vol (less leverage)",
      "notes": "SVXY restructuré pour être moins leveraged après incident"
    },
    "equity_us_large_feb_2018": {
      "weekly_return_pct": -10.0,
      "peak_drawdown_pct": -10.2,
      "peak_drawdown_date": "2018-02-08",
      "recovery_days": 56,
      "notes": "S&P 500 brief bear territory. Recovery en 2 mois."
    },
    "equity_us_q4_2018_bear": {
      "peak_drawdown_pct": -19.8,
      "peak_date": "2018-09-20",
      "trough_date": "2018-12-24",
      "duration_days": 95,
      "notes": "S&P 2940 → 2351. Techniquement pas ''bear market'' de 1 point (-20%). Christmas Eve 2018 = pire jour dec 24."
    },
    "equity_apple_q4_2018": {
      "peak_drawdown_pct": -38.0,
      "peak_level": 233,
      "trough_level": 142,
      "notes": "Apple sur earnings warning Chine (2 jan 2019). -10% le jour, catalyseur intermédiaire"
    },
    "equity_nvidia_2018": {
      "peak_drawdown_pct": -56.0,
      "peak_level": 292,
      "trough_level": 129,
      "notes": "NVDA peak Q3 2018 (crypto mining demand), trough Christmas 2018"
    },
    "equity_semis_soxx_2018": {
      "peak_drawdown_pct": -28.0,
      "notes": "SOXX (semis ETF) bear de mars à déc. Trade war + crypto crash + Apple warning"
    },
    "bitcoin_2018_winter": {
      "peak_level_usd": 19783,
      "peak_date": "2017-12-17",
      "trough_2018_level_usd": 3191,
      "trough_date": "2018-12-15",
      "peak_drawdown_pct": -84.0,
      "notes": "Crypto winter correspond à la même période macro. Drivers : bursting ICO bubble + Fed hiking + regulatory crackdown"
    },
    "govt_bonds_us_10y_q4_2018": {
      "peak_yield_pct": 3.24,
      "peak_date": "2018-11-08",
      "post_pivot_yield_pct": 2.68,
      "yield_move_bps": -56,
      "notes": "10y yield peak novembre 2018, commence à baisser AVANT equity trough (classique)"
    },
    "powell_pivot_4_jan_2019": {
      "sp500_daily_return_pct": 3.43,
      "week_after_return_pct": 5.1,
      "3m_after_return_pct": 19.0,
      "12m_after_return_pct": 36.0,
      "notes": "Speech Powell 4 jan 2019 (panel AEA Atlanta) = catalyseur bottom. Rally quasi-V-shape."
    },
    "fed_cuts_2019": {
      "july_2019": "-25bps (première cut depuis 2008)",
      "september_2019": "-25bps",
      "october_2019": "-25bps",
      "notes": "Pas techniquement ''cutting cycle'' (Powell parle d''''insurance cuts''), mais en pratique bien des cuts préventifs"
    }
  }'::jsonb,

  '{
    "before_volmageddon": "Short-vol était le trade crowded permanent : carry high (vol implicite > réalisée), backtest stellar 2012-2017, ETNs massifs. Risque queue systématiquement sous-estimé.",
    "after_volmageddon": "Short-vol industry réduite de 70%. Leveraged inverse vol ETNs réglementés différemment. Risk management teams réévaluent tail risk.",
    "before_pivot": "Fed data-dependent mais path d''hikes perçu comme ''on auto-pilot''. QT à $50B/mois ''comme peinture qui sèche''.",
    "after_pivot": "''Powell put'' confirmé (après ''Bernanke put'', ''Yellen put''). Fed redevient ultra-sensible aux markets. ''Data-dependent'' devient excuse pour être dovish. Mondialisation du ''Fed put'' : toute tightening future sera tentative de contenir sans tanker markets."
  }'::jsonb,

  'Volmageddon : récupération 2 mois S&P. Short-vol industry restructuré mais pas éliminé. Fed pivot janvier 2019 → bull resume, new ATH S&P 500 26 avril 2019. Fed ''insurance cuts'' 3x en 2019 (juillet, sept, oct). QT pause puis end mars 2019. 2019 un des meilleurs années S&P (+31%). Fin 2019 : S&P 500 à 3230, 37% au-dessus du trough Christmas Eve.',

  '[
    "Positioning systémique crowded = tail risk non-linéaire — short vol explicit OU implicit (risk parity, vol targeting, capital protecting structured products) représente des trillions",
    "Les produits inverse leveragés ont des path-dependency risks catastrophiques (daily rebalancing) — XIV mort, UVXY vit grâce à regulation",
    "VIX ETFs/ETNs sont des outils d''exposition, pas des investissements long-term — décroissance structurelle ~90% annuelle",
    "La Fed est devenue STRUCTURELLEMENT dovish face aux stress marchés — Powell put est validé",
    "QT est difficile politiquement — chaque tentative depuis 2013 (taper, QT1 2017-2019, QT2 2022+) a été complicated",
    "Les bears de fin de cycle peuvent être courts si banque centrale pivote — pattern 2018/2019 vs 2008 vs 2000",
    "Communication Fed = outil ''de combat'' aussi puissant que taux eux-mêmes — Powell 4 jan 2019 = équivalent Draghi 2012",
    "Apple Q4 2018 = indicateur leader demand Chine — surveiller iPhone revenue Chine",
    "Crypto corrèle inversement avec risk-off/Fed hawkish (winter 2018) et positivement avec Fed dovish (2020 rally)",
    "2y10y flattening vers inversion → typiquement 12-24 mois avant recession — 2018 inversion courte (Aug 2019) → recession COVID 2020 OK mais catalyst externe"
  ]'::jsonb,

  '[
    "Short-vol industry 2018 était overcrowded dans des structures SPECIFIC (XIV, SVXY) — 2024+ les crowded trades sont ailleurs (magnificent 7, passive flows, volatility selling option strategies)",
    "Fed pivot 2019 était sur INFLATION soft (sub-2%) — un pivot similaire en régime inflation high (2022+) impossible",
    "Powell put confirmé mais limité par contrainte inflation — en cas de bear market AVEC inflation, Fed contrainte",
    "Le pattern Q4 correction + Jan pivot n''est pas garanti — 2022 a été un 12 mois bear sans pivot avant mars 2023 (SVB crisis)",
    "Crypto winter 2018 vs crypto winter 2022 : patterns différents (2022 = FTX + Terra collapse, structurel ; 2018 = speculative unwind)"
  ]'::jsonb,

  array['volatility_event','short_vol_unwind','fed_pivot','positioning_unwind','policy_communication_shock','xiv_termination','q4_bear_market','powell_put']::text[],

  'warning',
  'excellent',

  '[
    {"type":"paper","title":"The Volmageddon of 5 February 2018","authors":"Office of Financial Research","year":2018,"publisher":"US Treasury OFR"},
    {"type":"article","title":"The Day That Wiped Out Two Years of Stock-Market Gains","publisher":"Bloomberg","year":2018},
    {"type":"speech","title":"Discussion at American Economic Association Atlanta","authors":"Jerome Powell","year":2019,"publisher":"Federal Reserve"},
    {"type":"paper","title":"Tail Risk in the Short-Volatility Trade","authors":"Karolyi, McLaughlin","year":2020},
    {"type":"data","title":"CBOE VIX historical data","publisher":"CBOE"},
    {"type":"paper","title":"Fed Communications and Equity Market Reaction","authors":"Ehrmann, Fratzscher","year":2019}
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
  references=excluded.references, updated_at=now();
