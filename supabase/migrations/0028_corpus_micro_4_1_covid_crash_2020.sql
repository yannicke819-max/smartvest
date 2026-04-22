-- Migration 0028 — Corpus micro 4.1/6 : COVID Crash + Fed Emergency Response
--
-- Le bear market le plus rapide de l''histoire (-34% en 23 jours de trading)
-- suivi de la plus grande réponse monétaire et fiscale jamais déployée.
-- Pattern : pandémie shock + policy response unprecedented → V-shape recovery.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'covid_crash_and_fed_response_2020',
  'COVID-19 Crash + Unprecedented Fed/Treasury Response',
  'pandemic',
  '2020-02-19',
  '2020-08-18',
  '6 mois du peak S&P 500 (19 fév) au retour au ATH (18 août) — bear market + V-recovery',
  'Le 19 février 2020, le S&P 500 atteint 3386 (ATH). Les marchés commencent à pricer COVID-19 la semaine du 24 février avec éclosion cas italiens. Le 9 mars (''Black Monday''), circuit breakers NYSE déclenchés (S&P -7% à l''ouverture). Le 12 mars, WHO déclare pandémie. Le 16 mars, VIX close à 82.69 (record historique dépassant 2008). Le 23 mars 2020, S&P 500 bottome à 2237 (-33.9% en 23 jours = fastest bear ever). Le même jour, Fed annonce ''QE infinity'' sans limite. Les actions COVID rallient instantanément. Le 9 avril Fed ajoute 2.3 T$ de facilités credit. Le 20 avril, WTI futures livraison mai clôturent à -37.63$ (prix NÉGATIF pour la première fois de l''histoire). La réponse politique est MASSIVE : Fed balance sheet passe de 4.2 T$ à 7.2 T$ en 3 mois, Fed cuts de 1.75% à 0-0.25% en 2 emergency meetings (3 et 15 mars), CARES Act 2.2 T$ signé 27 mars, PPP 349 Md$ + PPP2 310 Md$, Main Street Lending, CPFF/MMLF/PDCF/TALF/PMCCF/SMCCF facilities. S&P 500 retrouve son ATH le 18 août 2020 (5 mois) — fastest recovery de l''histoire.',

  '[
    "Premier bear market pandemic de l''histoire moderne (1918 Spanish Flu limited market data)",
    "Fed emergency cut 3 mars (-50bps) puis 15 mars (-100bps) = 1.75% → 0-0.25% en 12 jours",
    "Fed balance sheet : 4.2 T$ (fév 2020) → 7.2 T$ (juillet 2020) = +3 T$ en 4 mois",
    "Fed crée 9+ facilités: CPFF, MMLF, PDCF, TALF 2.0, SMCCF (Secondary Market Corporate Credit Facility), PMCCF (Primary), Main Street Lending Program, Paycheck Protection Liquidity Facility",
    "PREMIÈRE FOIS Fed achète directement dettes corporate (IG + même Fallen Angels BBB-)",
    "CARES Act 2.2 T$ (27 mars 2020) — plus grand package fiscal jamais signé à l''époque",
    "Paycheck Protection Program (PPP): 349 Md$ initial (avril), 310 Md$ supplémentaires (mai)",
    "WTI futures NEGATIF (-37.63$) 20 avril 2020 — physical storage saturée à Cushing",
    "Circuit breakers NYSE déclenchés 4 fois en 10 jours (9, 12, 16, 18 mars) — jamais arrivé depuis leur création 1987"
  ]'::jsonb,

  '[
    "Premier cas COVID Wuhan décembre 2019, négligé par marchés jusqu''à fin janvier 2020",
    "Chinese lockdowns Wuhan le 23 janvier — impact pricé partiellement",
    "Italian cases explosion 20-24 février — début panique EU",
    "US cases confirmés début mars → accélération",
    "Oil war saoudo-russe démarre 8 mars (Saudi augmente production après RU refuse cut) → amplifie choc",
    "Structural : positioning risk-parity et vol-targeting saturé début 2020 (post Powell pivot 2019)",
    "Valuations equity rich : S&P 500 forward P/E 19x (highest depuis 2002)",
    "Bond yields déjà bas : US 10y à 1.5% début février → deleveraging déclenche flight to quality extrême"
  ]'::jsonb,

  '{
    "equity_us_large": {
      "peak_level": 3386.15,
      "peak_date": "2020-02-19",
      "trough_level": 2191.86,
      "trough_date": "2020-03-23",
      "peak_drawdown_pct": -33.9,
      "duration_to_trough_days": 23,
      "recovery_date": "2020-08-18",
      "duration_to_recovery_days": 181,
      "notes": "Fastest bear (23 jours) + fastest recovery (5 mois) de l''histoire. Normal : 100+ jours to trough, 3+ ans to recovery."
    },
    "equity_russell_2000": {
      "peak_drawdown_pct": -41.0,
      "notes": "Small caps amplifient comme toujours en liquidity crunch"
    },
    "equity_faang_stay_home": {
      "aapl_h1_return_pct": 43.0,
      "amzn_h1_return_pct": 49.0,
      "nflx_h1_return_pct": 50.0,
      "zoom_2020_return_pct": 396.0,
      "peloton_2020_return_pct": 440.0,
      "notes": "''Stay-home trade'' massive. AAPL, AMZN, NFLX, ZM, PTON, NVDA, TSLA etc. outperformance extrême"
    },
    "vix": {
      "peak_level": 82.69,
      "peak_date_close": "2020-03-16",
      "intraday_peak": 85.47,
      "notes": "VIX close 82.69 le 16 mars 2020 — record absolu dépassant 2008 (80.86). Intraday 85.47."
    },
    "commodities_oil_wti": {
      "peak_drawdown_pct": -300.0,
      "negative_close_usd": -37.63,
      "negative_date": "2020-04-20",
      "brent_low_usd": 16.0,
      "notes": "WTI futures NÉGATIFS (contract may 2020 expire sans acheteurs, storage full Cushing). Événement inédit."
    },
    "commodities_gold": {
      "crisis_low_level_usd": 1470,
      "crisis_peak_level_usd": 2075,
      "peak_date": "2020-08-07",
      "return_pct": 41.0,
      "notes": "Or brief sell-off phase 1 (déleveraging forcé) puis rally massive sur Fed expansion. Nouveau ATH $2075 en août."
    },
    "govt_bonds_us_10y": {
      "pre_event_yield_pct": 1.59,
      "trough_yield_pct": 0.31,
      "trough_date": "2020-03-09",
      "yield_move_bps": -128,
      "notes": "10y yield 0.31% record historique. Jamais sous 1% avant COVID."
    },
    "credit_ig": {
      "spread_peak_bps": 401,
      "pre_event_bps": 101,
      "spread_widening_bps": 300,
      "notes": "IG OAS 101 → 401bps en 3 semaines. SMCCF annonce calme immédiatement."
    },
    "credit_hy": {
      "spread_peak_bps": 1087,
      "pre_event_bps": 358,
      "notes": "HY OAS +730bps en 3 semaines. Energy sector dominant (70% des -drops)."
    },
    "fx_dxy": {
      "peak_level": 102.99,
      "peak_date": "2020-03-20",
      "notes": "DXY spike sur dollar shortage global — classic flight-to-dollar. Revert quickly once Fed swap lines + QE."
    },
    "bitcoin": {
      "pre_event_level_usd": 10000,
      "crash_low_usd": 3858,
      "crash_date": "2020-03-12",
      "daily_drawdown_pct": -50.0,
      "notes": "Bitcoin ''Black Thursday'' 12 mars : -50% en 24h. Forced liquidations ($1B+ liquidated BitMEX). Puis rally structurel vers $29000 fin 2020."
    }
  }'::jsonb,

  '{
    "before": "Fed funds 1.5-1.75%. Bilan Fed 4.2 T$ (~20% PIB). Pas de politique fiscale coordonnée disponible. Corporate credit facilities n''existent pas.",
    "after": "Fed funds 0-0.25% (stay 2 ans). Bilan Fed 7.2 T$ puis 9 T$ peak (2022). Corporate credit facilities institutionnalisées. ''Fed as lender of last resort to everyone'' confirmé. Deficit public >15% PIB 2020 (unprecedented peace time). Monetary-fiscal coordination extrême. Premiers seeds de l''inflation 2022 plantés.",
    "retail_trading_boom": "Retail trading explose : Robinhood +13M comptes 2020, TD +4M, comission-free bull market. Options retail volume +2x, meme stocks pre-figurés"
  }'::jsonb,

  'Recovery V-shape : S&P retourne ATH 18 août 2020. Fed balance sheet continue d''expanser. Vaccines annoncés novembre 2020 (voir micro 4.2). Cyclical value rotation nov 2020. 2021 = everything bubble peak (SPACs, meme stocks, crypto $3T cap, NFTs). Inflation commence à monter mi-2021 (voir micro 4.4). Fed hiking cycle 2022 sort les marchés de ce régime.',

  '[
    "Fastest bear de l''histoire suivi de fastest recovery — pattern pandemic + policy response massive",
    "Fed peut désormais acheter ANY asset class en crisis (corporates, fallen angels, municipal via facilities) — limite politique seulement",
    "Positioning saturé pré-crisis (risk-parity, vol-targeting) amplifie les crashes — deleveraging mécanique",
    "Circuit breakers fonctionnent (vs 1987) — aucun flash crash malgré stress",
    "WTI négatif = rappel que le pétrole est physique, pas financier — storage matters",
    "Le dollar spike en stress global même si Fed cut — ''dollar shortage'' offshore (répète pattern 2008)",
    "Fed swap lines avec autres banques centrales CRITIQUES pour normaliser dollar — activées 19 mars 2020",
    "Corporate credit facilities Fed calment les spreads en quelques jours MÊME AVANT d''acheter — signaling power",
    "Small caps + HY credit leading indicators de risk-on rebound (outperformance dès le bottom)",
    "Stay-home tech trade massif (Zoom, Peloton etc.) fonctionne ~18 mois, puis mean-reverts brutalement 2021-2022",
    "Retail trading explose pendant lockdowns → effets persistants (meme stocks 2021, crypto mania 2021, options flow)",
    "L''inflation 2022 était déjà semée par monetary expansion 2020-2021 — lag 12-18 mois"
  ]'::jsonb,

  '[
    "COVID était un shock EXOGÈNE — pattern ne s''applique pas aux crises endogènes (2008, 2022)",
    "Inflation était absente pre-COVID → Fed avait marge pour policy response illimitée",
    "Post-COVID, inflation contraint la Fed — nouvelle crise avec inflation ne pourra pas avoir même réponse",
    "Fed aurait aussi de la difficulté à relancer des facilities corporate si inflation > 3% persistente",
    "Valuations 2020 étaient hautes mais pas aussi étirées que 2021 peak → bear 2022 partait de plus haut",
    "Policy fiscale coordonnée 2020 (CARES) impossible à reproduire dans climat politique polarisé",
    "Post-2020, retail flow plus discipliné après losses 2021-2022 — potentiellement moins amplificateur",
    "Risk-parity / vol-targeting strategies ont reduit leur AUM post-2020 — amplification mécanique moindre"
  ]'::jsonb,

  array['pandemic','exogenous_shock','fastest_bear','fed_qe_infinity','corporate_credit_facility','v_shaped_recovery','circuit_breakers','dollar_shortage','oil_negative','retail_trading_boom','policy_coordination']::text[],

  'systemic',
  'excellent',

  '[
    {"type":"speech","title":"Transcripts of March 15, 2020 FOMC emergency meeting","authors":"Federal Reserve","year":2020},
    {"type":"report","title":"CARES Act Oversight Report","publisher":"Congressional Oversight Commission","year":2020},
    {"type":"paper","title":"The Federal Reserve''s Response to the COVID-19 Crisis","authors":"Fleming, Sarkar, Van Tassel","year":2020,"publisher":"NY Fed"},
    {"type":"report","title":"The COVID-19 Shock and Central Bank Actions","publisher":"BIS","year":2020},
    {"type":"book","title":"Trillion Dollar Triage","authors":"Nick Timiraos","year":2022,"publisher":"Little Brown"},
    {"type":"data","title":"Federal Reserve H.4.1 balance sheet","publisher":"Federal Reserve"}
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
