-- Migration 0026 — Corpus micro 3.4/5 : Brexit Referendum (23 juin 2016)
--
-- Cas d''école du MAUVAIS pricing-in par les marchés. Prediction markets
-- et sondages favorisaient Remain jusqu''à la veille. Résultat Leave →
-- GBP -8% overnight (biggest 1-day move since 1970). Divergence brutale
-- FTSE 100 (-3%) vs FTSE 250 (-7%) — proxy exposition domestique vs globale.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, source_references
) values (
  'brexit_referendum_2016',
  'UK Brexit Referendum',
  'election_event',
  '2016-06-23',
  '2016-07-06',
  'Choc initial overnight 23-24 juin, réplicas sur 2 semaines',
  'Le 23 juin 2016, le Royaume-Uni vote par référendum à 51.9% pour quitter l''Union européenne. Le résultat est une surprise pour les marchés : prediction markets (Betfair) donnaient Remain à 85% la veille, sondages moyennes à 52% Remain, positioning GBP long extrême. Le GBP/USD s''effondre overnight de 1.5018 (peak asiatique sur early vote à Leave lead) à 1.3229 (bottom tokyo matin) — un mouvement de -12% en 6 heures sur la cable, le plus gros move 1-jour depuis l''abandon de Bretton Woods en 1971. L''ouverture UK sell-off massif, mais divergence frappante : FTSE 100 ferme -3.15% seulement (car 70% des revenus des sociétés FTSE 100 sont hors UK, donc GBP faible = bullish pour multinationales), alors que FTSE 250 (mid-caps plus exposées UK domestic) -7.19%. Banques UK -15 à -25% (Barclays -20%, RBS -25%). Or +4.7% (safe haven). Gilts rally (yields 10y 1.35% → 0.72% en 8 semaines, record historique). S&P 500 -3.6% vendredi, mais récupère entièrement en 2 semaines. La crise politique UK (Cameron démissionne), la dépréciation durable du GBP (de 1.50 à 1.20 en octobre 2016), et les négociations complexes s''étalent sur 4 ans. Brexit effectif : 31 janvier 2020 (et sortie marché unique 31 déc 2020).',

  '[
    "Vote 51.9% Leave / 48.1% Remain (turnout 72.2% — record)",
    "Prediction markets (Betfair) : Remain à 85% la veille → 7% 3 heures après résultats Sunderland",
    "Positioning GBP long extrême (hedge funds, real money) — Goldman Sachs publiait cible 1.60",
    "FTSE 100 cushion via composition multinationale (70% revenus hors UK)",
    "Carney (BoE) intervention immédiate 24 juin matin : ''contingency plans in place''",
    "Cameron démission annoncée 24 juin 08h00 → incertitude politique amplifiée",
    "Theresa May Premier Ministre 13 juillet 2016",
    "Article 50 déclenché 29 mars 2017, 9 mois après vote — les marchés PRICENT le délai"
  ]'::jsonb,

  '[
    "Sondages 6 mois avant oscillaient 45-55 Remain/Leave — incertitude mais favoris Remain",
    "Prediction markets (plus accurate historiquement) basculent vers Leave seulement 72h avant",
    "GBP/USD peak à 1.50 le 23 juin (day-of vote) sur late asian bets Remain — positioning maximal",
    "Fear of Brexit avait déjà pesé : GBP -8% depuis novembre 2015 avant vote",
    "CDS souverain UK à 32bps (vs 12bps France) — prime de risque structurelle",
    "VIX était low (17 le 23 juin) — complacency sur outcome Remain pricé",
    "1:1 parallèle Scottish Indyref 2014 (Scotland votes No) → market pattern expected repeat"
  ]'::jsonb,

  '{
    "fx_gbpusd": {
      "pre_event_level": 1.5018,
      "overnight_low": 1.3229,
      "overnight_move_pct": -11.9,
      "close_friday_level": 1.3687,
      "3m_later_level": 1.2350,
      "notes": "Cable de 1.50 à 1.33 en 6 heures. Biggest 1-day move since 1971 Bretton Woods breakdown. -14% sur 3 mois."
    },
    "fx_gbpeur": {
      "overnight_move_pct": -8.0,
      "pre_event_level": 1.3081,
      "3m_later_level": 1.10,
      "notes": "EUR/GBP rallye de 0.7647 à 0.9300 sur 3 mois"
    },
    "equity_ftse_100": {
      "close_day_after_pct": -3.15,
      "peak_intraday_pct": -8.7,
      "peak_to_2w_recovery_pct": 5.2,
      "notes": "FTSE 100 close -3.15% seulement — multinationales bénéficient GBP faible. 2 semaines plus tard en hausse sur l''année."
    },
    "equity_ftse_250": {
      "close_day_after_pct": -7.19,
      "peak_drawdown_pct": -14.0,
      "peak_drawdown_date": "2016-07-06",
      "notes": "FTSE 250 mid-caps domestiques UK bien plus impactées. Divergence structurelle avec FTSE 100."
    },
    "equity_uk_banks": {
      "barclays_pct": -20.0,
      "rbs_pct": -25.0,
      "lloyds_pct": -19.0,
      "notes": "Banques UK -15 à -25% — double whammy : GBP weakness + crise politique + perspective récession"
    },
    "equity_eu_broader": {
      "eurostoxx_50_pct": -8.6,
      "dax_pct": -6.8,
      "notes": "Europe continent broadly down — fear of EU breakup contagion"
    },
    "govt_bonds_uk_10y": {
      "pre_event_yield_pct": 1.35,
      "trough_yield_pct": 0.52,
      "trough_date": "2016-08-15",
      "yield_move_bps": -83,
      "notes": "Gilt 10y yield record low 0.52% août 2016. Flight to quality + BoE cuts attendus"
    },
    "govt_bonds_us_10y": {
      "pre_event_yield_pct": 1.74,
      "trough_yield_pct": 1.36,
      "trough_date": "2016-07-05",
      "notes": "US 10y record low 1.36% sur Brexit flight-to-quality global"
    },
    "commodities_gold": {
      "daily_return_pct": 4.7,
      "intraday_high_pct": 8.0,
      "pre_event_usd": 1255,
      "post_event_1m_usd": 1370,
      "notes": "Or +4.7% sur la journée, safe-haven par excellence"
    },
    "vix": {
      "pre_event_level": 17.25,
      "intraday_high": 26.72,
      "close_friday": 25.76,
      "1w_later": 16.74,
      "notes": "VIX spike mais mean-revert rapide — événement localisé, pas systémique"
    },
    "s_and_p_500": {
      "daily_close_pct": -3.6,
      "2w_recovery_pct": 5.8,
      "notes": "S&P -3.6% vendredi 24 juin, mais RECORD HIGH 11 juillet — crise britannique, pas globale"
    }
  }'::jsonb,

  '{
    "before": "UK perçu comme pro-EU stable. Cameron confiant. Sondages proches 50/50 mais bookies à 85% Remain. Immigration + sovereignty narratives sous-estimées par élites.",
    "after": "Populisme anti-establishment valide (quelques mois avant Trump). EU fragility exposed (Italy, France, Netherlands future tests). GBP reprice structurellement de 30% vs pre-Brexit trendline. Financial services City de Londres graduellement relocalisés (Amsterdam, Paris, Dublin, Francfort). 4 années négociations chaotiques (May, Johnson, 2 General Elections)."
  }'::jsonb,

  'Dépréciation structurelle GBP (1.50 → 1.20 sur 3 ans, jamais retourné au niveau pré-vote). UK économie : surperformance initiale (pound weak = exports), puis underperformance structurelle 2018+ (investment et productivity hit). Brexit effectif 31 jan 2020 (sortie UE politique), 31 déc 2020 (sortie marché unique + union douanière). Accord commercial minimal (TCA). Effet négatif documenté sur PIB UK : -4 à -5% vs contrefactuel (OBR, NIESR).',

  '[
    "Les marchés mispricent systématiquement les risques politiques avec outcomes binaires — positioning complacency autour du consensus",
    "Prediction markets (Betfair, PredictIt) pas fiables quand outcome pricé implique gros positioning — ''wisdom of crowds'' biaisée par flows",
    "Sondages non-scientifiques sur les segments silencieux (''Shy Tory'' effect, ''Shy Leave'' effect)",
    "Les référendums/élections à forts impacts binaires = event study pur : PRE-EVENT pricing + OVERNIGHT gap + post-event drift",
    "FTSE 100 vs FTSE 250 divergence = template : distinguer indices par exposition domestique vs globale",
    "Le protection via options (puts GBP, FTSE) était bon marché la veille — event risk mispricé",
    "Safe-haven classiques fonctionnent : gold, US Treasuries, JPY, CHF",
    "La récupération equity globale rapide (2 semaines S&P) montre que les événements politiques localisés ont effet systémique limité — sauf contagion régionale",
    "Les currencies sous-performent longtemps après political shock (GBP 3+ ans) alors que equities récupèrent — divergence duration",
    "Positioning data (CFTC commitments of traders, risk reversals options) sont des leading indicators — GBP était crowded long pré-vote"
  ]'::jsonb,

  '[
    "Chaque élection/référendum a sa propre dynamique — Brexit context (EU identity crisis) différent de Trump 2016 ou French 2017",
    "Prediction markets ont INTÉGRÉ la leçon Brexit : gonflent les outsiders depuis (Trump 2016, Ireland 2022, etc.)",
    "La divergence FTSE 100/250 est UK-specific (composition multinationale exceptionnelle) — pas transférable directement",
    "UK Brexit a été un processus de 4 ans — impact échelonné, pas one-shot",
    "Pattern applicable à d''autres breakups potentiels : Scotland indyref 2, Catalonia, future US-state secession theatrics"
  ]'::jsonb,

  array['election_shock','binary_event_mispriced','political_risk','fx_gap','safe_haven_rally','domestic_vs_multinational_divergence','populism']::text[],

  'warning',
  'excellent',

  '[
    {"type":"paper","title":"The Economic Consequences of the Brexit Vote","authors":"Breinlich, Leromain, Novy, Sampson","year":2019,"publisher":"Oxford Review of Economic Policy"},
    {"type":"report","title":"Brexit Economic Impact","publisher":"OBR","year":2020},
    {"type":"paper","title":"Brexit: The Economics","authors":"Sampson","year":2017,"publisher":"Journal of Economic Perspectives"},
    {"type":"book","title":"All Out War: The Full Story of Brexit","authors":"Tim Shipman","year":2016,"publisher":"Williams Collins"},
    {"type":"data","title":"BoE financial stability reports","publisher":"Bank of England"}
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
  source_references = excluded.source_references, updated_at=now();
