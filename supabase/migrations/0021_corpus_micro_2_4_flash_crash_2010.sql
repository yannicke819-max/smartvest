-- Migration 0021 — Corpus micro 2.4/5 : Flash Crash (6 mai 2010)
--
-- Premier krach éclair attribuable à la microstructure de marché et
-- au HFT. Révèle que la plomberie moderne peut faire dysfonctionner
-- les marchés indépendamment des fondamentaux.
--
-- Valeur pédagogique : tout prix affiché n''est pas un prix valide.
-- Pattern qui reviendra (volmageddon 2018, COVID mars 2020 bond market,
-- GameStop 2021, yen carry août 2024). Critique pour l''AI analyst
-- qui propose des ordres — jamais de market order sans limit price.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'flash_crash_2010_may',
  'May 6, 2010 Flash Crash',
  'market_stress',
  '2010-05-06',
  '2010-05-06',
  'Événement intraday 36 minutes (14h32 - 15h08 ET), récupération même jour',
  'Le 6 mai 2010 à 14h32:00 ET, le DJIA plonge de -998.50 points (-9.16%) en 5 minutes, pour récupérer 600 points en 15 minutes. Pic intraday swing : 1010 points ($1 trillion de valeur de marché volatilisé puis récupéré). Des actions individuelles fixent des prix absurdes : Accenture $0.01 (vs 41$ ouverture), Procter & Gamble $39.37 (-37%), Apple $199 (-22% puis rebond complet). 20 000 trades exécutés à 60%+ du prix pré-crash seront ensuite CANCELLÉS par le NYSE. Analyse post-mortem (SEC-CFTC 2010) : ordre massif de vente de 75 000 contrats E-mini S&P (4.1 Md$) par Waddell & Reed, exécuté par un algo mal paramétré (VWAP sur volume, pas sur prix), en plein contexte de stress (crise grecque). Les HFTs absorbent initialement, puis inversent en net sellers. Les ''stub quotes'' (ordres cosmetic à $0.01) sont frappés par des market orders paniqués. Plus tard : accusation de spoofing contre Navinder Sarao (trader londonien), condamné en 2016.',

  '[
    "Ordre de vente 75000 E-mini S&P futures contracts ($4.1B notional) sur 20 minutes via algo VWAP non capé",
    "Algo Waddell & Reed paramétré uniquement sur volume, pas sur prix (pas de limite de baisse acceptée)",
    "HFTs initial buyers puis flip to net sellers → disparition de la liquidité en quelques secondes",
    "Stub quotes (bid/ask fantômes à 0.01$) absorbent les market orders paniqués",
    "20 000 trades ultimately cancelled par NYSE (politique ''clearly erroneous'')",
    "Spoofing / layering : Navinder Sarao placé-annulé des millions d''ordres pour créer fausse pression vendeuse (accusation prouvée ex-post)",
    "Fragmentation de la liquidité : 13 venues US equity (NYSE, Nasdaq, BATS, Direct Edge, dark pools...) — aucune vue consolidée du carnet d''ordres"
  ]'::jsonb,

  '[
    "Crise grecque en escalade — yields grecs 10y explosent semaine précédente (ECB meeting 6 mai matin = déception)",
    "VIX déjà élevé à 25-30 en ouverture (vs 17 début mai)",
    "Volatilité intraday en hausse depuis 3 séances",
    "Marché couvert (demand for puts élevée)",
    "Aucun signal spécifique pré-14h32 — l''événement est ENDOGÈNE à la microstructure, pas macro",
    "Positioning HFT dominant sur E-mini (~70% du volume intraday)",
    "Pas de circuit breakers individuels sur actions (introduits APRÈS le flash crash)"
  ]'::jsonb,

  '{
    "equity_us_large": {
      "intraday_low_pct": -9.16,
      "intraday_recovery_pct": -3.24,
      "close_pct": -3.24,
      "notes": "S&P 500 intraday low 1065.79 (-9.16% de l''ouverture). Close 1128.15 (-3.24%). Pic swing 10h08 à 14h45 = 6% récupérés en 37 minutes."
    },
    "individual_stocks_extreme": {
      "accenture": {"pre_crash": 41.09, "intraday_low": 0.01, "close": 40.73, "duration_at_low_seconds": 7},
      "procter_gamble": {"pre_crash": 62.00, "intraday_low": 39.37, "close": 60.84, "notes": "P&G sur Dow = spike baisse amplifie DJIA"},
      "apple": {"pre_crash": 255, "intraday_low": 199, "close": 246, "notes": "Apple tested $100K USD market cap haircut in seconds"},
      "pg_etf_russell_3000": {"note": "IVV (S&P 500 ETF) bid $68, ask $30 pendant le flash — désynchronisation ETF/constituents"}
    },
    "vix": {
      "opening_level": 25.9,
      "intraday_peak": 40.95,
      "close_level": 32.80,
      "peak_date": "2010-05-06",
      "notes": "VIX +25% en séance — jamais de tel move en une journée (hors 2008, COVID)."
    },
    "govt_bonds_us_10y": {
      "intraday_yield_move_bps": -15,
      "notes": "Flight to quality bref mais marqué. 10y yield passe de 3.55 à 3.40% en minutes."
    },
    "fx_eurusd": {
      "intraday_low": 1.2510,
      "open_level": 1.2830,
      "move_pct": -2.5,
      "notes": "EUR/USD plonge en même temps — intensification crise grecque simultanée amplifie la panique."
    },
    "etf_price_distortion": {
      "ivv": {"distortion_pct": 50, "duration_seconds": 300, "notes": "IVV (S&P 500 ETF) traded 50% below NAV intraday. Principal exemple de divergence ETF/sous-jacent en stress."},
      "vti": {"distortion_pct": 40, "notes": "Total market ETF similarly dislocated"}
    }
  }'::jsonb,

  '{
    "before": "Microstructure perçue comme robuste. HFT vu comme fournisseur de liquidité net positif. Pas de circuit breakers individuels. Market orders considérés comme sûrs pour l''exécution.",
    "after": "Circuit breakers individuels introduits juin 2010 (pause trading si ±10% en 5 minutes pour actions S&P 500). Limit Up-Limit Down (LULD) 2012. Règle clearly erroneous renforcée. HFT officiellement régulé. Prise de conscience retail : jamais de market order sur marché illiquide/volatil."
  }'::jsonb,

  'Récupération intraday complète (S&P -3.2% en clôture). Mais confiance dans la microstructure durablement entamée. SEC-CFTC Joint Advisory Committee Report (septembre 2010) identifie les causes. Navinder Sarao arrêté en 2015, plaide coupable 2016, sentenced 2020. Introduction Limit Up-Limit Down (LULD) en 2012 puis consolidation 2014 — plus aucun flash crash de cette ampleur depuis (petits épisodes résiduels : août 2015, VIX 2018).',

  '[
    "Tout prix affiché n''est pas un prix valide en condition de stress — les market orders peuvent s''exécuter à des prix absurdes",
    "Les stub quotes ($0.01 bids) existent parce que des market makers doivent poster quote — éviter market orders à tout prix en IL-liquide",
    "Les ETFs peuvent dé-synchroniser de leur NAV en stress intense (50% off en flash crash, 20-30% en mars 2020 sur bond ETFs)",
    "L''algo mal paramétré d''un gros acteur peut déclencher une cascade — toujours capper les ordres sur PRIX et VOLUME",
    "HFTs sont fournisseurs de liquidité en régime normal, retirent liquidité en régime de stress — pas neutre",
    "Les circuit breakers individuels (LULD) existent précisément pour couper ce scénario — mais fonctionnent seulement SI les exchanges coopèrent (pas toujours le cas en crypto)",
    "Le comportement de la plomberie est systémique : une vente dans E-mini déclenche cascade sur equities individuelles via arbitrage statistique et ETFs",
    "Le prix affiché d''un ETF peut être différent du NAV fair value de 50%+ en flash — toujours vérifier iNAV (intraday NAV) pour ETFs",
    "Crypto a amplifié ce pattern : flash crashes Binance, Coinbase réguliers — pas de circuit breakers unifiés"
  ]'::jsonb,

  '[
    "Circuit breakers et LULD introduits depuis 2012 ont fortement réduit la probabilité d''un flash crash même ampleur sur S&P 500",
    "Mais PAS éliminé : épisodes résiduels (24 août 2015, février 2018 volmageddon, 23 avril 2013 hack AP Twitter)",
    "Le pattern persiste en FX (flash crash yen janvier 2019), Treasuries (mars 2020), crypto (multiples)",
    "2010 était un événement ENDOGÈNE (microstructure) ; les flash moves modernes sont souvent EXOGÈNES (news trigger × microstructure amplification)",
    "Les dark pools et internalizers représentent 40%+ du volume US aujourd''hui — visibility réduite sur le carnet d''ordres encore plus qu''en 2010"
  ]'::jsonb,

  array[
    'microstructure_failure',
    'hft_liquidity_vanish',
    'algo_cascade',
    'etf_dislocation',
    'flash_move',
    'liquidity_crunch',
    'intraday_event',
    'execution_risk'
  ]::text[],

  'critical',
  'excellent',

  '[
    {"type":"report","title":"Findings Regarding the Market Events of May 6, 2010","authors":"CFTC-SEC Joint Advisory Committee","year":2010,"url":"sec.gov/news/studies/2010/marketevents-report.pdf"},
    {"type":"book","title":"Flash Boys: A Wall Street Revolt","authors":"Michael Lewis","year":2014,"publisher":"W.W. Norton"},
    {"type":"book","title":"Dark Pools: The Rise of the Machine Traders","authors":"Scott Patterson","year":2012,"publisher":"Crown Business"},
    {"type":"paper","title":"High-Frequency Trading in the Foreign Exchange Market","authors":"Bank for International Settlements","year":2011},
    {"type":"paper","title":"The Flash Crash: The Impact of High Frequency Trading on an Electronic Market","authors":"Kirilenko, Kyle, Samadi, Tuzun","year":2017,"publisher":"Journal of Finance"}
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
