-- Migration 0019 — Corpus micro 2.2/5 : QE1 Launch (25 nov 2008)
--
-- Premier programme de Quantitative Easing de l'histoire US moderne.
-- Bascule de régime monétaire : la Fed passe du pilotage par les taux
-- au pilotage par le bilan. Ouvre l'ère de la ''balance sheet policy''
-- qui va dominer la décennie 2008-2018 et revenir post-COVID.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, source_references
) values (
  'qe1_2008_launch',
  'Fed Quantitative Easing Round 1 (QE1)',
  'policy_shift',
  '2008-11-25',
  '2010-03-31',
  '16 mois, 2 phases : annonce initiale (nov 2008) + expansion mars 2009',
  'Le 25 novembre 2008, la Fed annonce l''achat de 600 Md$ de MBS d''agences (Fannie/Freddie) + 100 Md$ de dette d''agences. C''est la première intervention de QE depuis les achats du Trésor pendant WWII. Le 18 mars 2009, la Fed étend le programme à 1,25 T$ de MBS + 200 Md$ d''agences + 300 Md$ de Treasuries (QE1 "full"). L''objectif officiel : baisser les taux hypothécaires pour stabiliser l''immobilier. L''effet réel : signal massif au marché que la Fed ne laissera pas la déflation s''installer, prise en charge implicite du risque de duration par l''État, baisse rapide du cost of capital pour toute l''économie. Le 10y yield chute de 3% à 2% en quelques semaines, le S&P 500 commence à rebondir (pas au jour de l''annonce — l''annonce coïncide avec panique GM/Chrysler — mais avec l''expansion de mars 2009).',

  '[
    "Achat direct de 1.25 T$ de MBS d''agences par la Fed (premier QE de l''histoire moderne)",
    "Fed funds rate à 0-0.25% (cap du conventionnel atteint, passage au non-conventionnel)",
    "Signal politique : Fed ''ne laissera pas'' la déflation (briser les anticipations déflationnistes)",
    "Prise en charge implicite du risque de duration long par le bilan fédéral",
    "Effet Tobin''s Q : fair value des actions boostée par les taux d''actualisation plus bas",
    "Portfolio rebalancing : détenteurs de MBS forcés vers autres actifs risqués (corporate credit, equity)"
  ]'::jsonb,

  '[
    "Fed funds cut de 5.25% (sept 2007) à 0-0.25% (16 déc 2008) → fin du conventionnel",
    "TED spread à 463bps au pic (10 oct 2008) — système interbancaire gelé",
    "Case-Shiller en chute de -20% depuis pic 2006, accélération sept-nov 2008",
    "ABX subprime BBB tranches quasi-zéro",
    "Commercial paper market arrêté — corporate funding court impossible",
    "Depressive sentiment : VIX > 50, 10y breakeven inflation à 0% (anticipations déflation)",
    "Précédent japonais : BoJ avait tenté QE 2001-2006, résultats mitigés servant de roadmap inversé"
  ]'::jsonb,

  '{
    "equity_us_large": {
      "announcement_day_return_pct": -1.0,
      "return_6m_post_expansion_pct": 37.0,
      "notes": "S&P 500 ne rebondit PAS sur l''annonce initiale (panique GM/Chrysler simultanée). Mais l''expansion QE1 du 18 mars 2009 s''inscrit dans le rebond déjà amorcé 9 mars. +37% sur 6 mois post-expansion."
    },
    "govt_bonds_us_10y": {
      "yield_on_announcement_pct": 3.08,
      "yield_1m_later_pct": 2.05,
      "yield_move_bps": -103,
      "notes": "10y passe de 3.08% (21 nov 2008) à 2.05% (18 déc 2008). Baisse la plus rapide depuis des décennies."
    },
    "mortgage_rates_us_30y": {
      "pre_qe_pct": 6.38,
      "post_qe_pct": 5.05,
      "move_bps": -133,
      "notes": "30y fixed mortgage de 6.38% (24 oct 2008) à 4.78% (avril 2009). Refinancement massif → 1+ T$ d''équivalent stimulus pour les ménages."
    },
    "credit_ig": {
      "spread_peak_bps": 620,
      "spread_post_qe_bps": 250,
      "spread_tightening_bps": -370,
      "notes": "IG OAS de 620bps (déc 2008) à 250bps (déc 2009). Portfolio rebalancing effect."
    },
    "credit_hy": {
      "spread_peak_bps": 2047,
      "spread_post_qe_bps": 630,
      "spread_tightening_bps": -1417,
      "notes": "HY OAS de 2047bps à 630bps en 12 mois — plus grand resserrement de l''histoire."
    },
    "fx_dxy": {
      "peak_level": 89.0,
      "post_qe_level_6m": 76.3,
      "move_pct": -14.3,
      "notes": "DXY baisse de 89 (mars 2009) à 76 (oct 2009). QE perçu comme ''debasement'' du dollar."
    },
    "commodities_gold": {
      "pre_qe_level_usd": 720,
      "post_qe_level_12m": 1225,
      "return_pct": 70.0,
      "notes": "Or bénéficie massivement du QE — thèse ''debasement'' + haven. De 720$ (oct 2008) à 1225$ (nov 2009)."
    },
    "commodities_oil_brent": {
      "pre_qe_level_usd": 48,
      "post_qe_level_12m": 82,
      "return_pct": 71.0,
      "notes": "Oil double de $48 (mars 2009) à $82 (mars 2010). Reflation trade."
    },
    "fed_balance_sheet": {
      "pre_qe_size_usd": 0.9,
      "post_qe_size_usd": 2.3,
      "units": "trillion",
      "notes": "Bilan Fed de 900 Md$ (sept 2008) à 2.3 T$ (mars 2010). Première fois qu''une banque centrale majeure dépasse largement son bilan pré-crise."
    }
  }'::jsonb,

  '{
    "before": "Monetary policy = pilotage des taux courts (fed funds). Balance sheet stable ~6-8% PIB. Séparation claire politique monétaire / politique fiscale.",
    "after": "Balance sheet policy institutionnalisée. Fed bilan 20%+ PIB. ''Fed put'' perçu comme permanent. Carry trades sur USD short + long risk assets deviennent dominants. Volatility réalisée actions structurellement plus basse (compression vol par put implicite Fed).",
    "global_contagion": "BoE lance son QE en mars 2009 (75 Md£). BCE résiste jusqu''en 2015 (SMP puis OMT en 2012, QE proprement dit seulement janvier 2015). BoJ reprend QE en 2010 puis massif avec Abenomics 2013."
  }'::jsonb,

  'QE1 se termine formellement le 31 mars 2010 (fin des achats nets). Le bilan est ensuite maintenu (reinvestment des maturités). QE2 (novembre 2010, 600 Md$ Treasuries) et Operation Twist (sept 2011) suivent. QE3 (sept 2012) est open-ended (85 Md$/mois). Le ''tapering'' commence décembre 2013. Fed balance sheet peak à 4.5 T$ en 2015, puis QT lent 2017-2019. Nouveau cycle QE massif en mars 2020 (COVID).',

  '[
    "QE n''est pas inflationniste au sens monétariste naïf — la monnaie créée finit en réserves bancaires, pas dans l''économie réelle (si banques ne prêtent pas)",
    "QE est un ''signaling device'' autant qu''un instrument direct — l''annonce compte autant que l''exécution",
    "Effet portfolio rebalancing est mesurable : détenteurs de Treasuries forcés vers credit, credit forcé vers equity",
    "QE baisse la volatilité RÉALISÉE des actions mais pas la volatilité IMPLICITE immédiatement (VIX reste élevé des mois après)",
    "Asset prices (stocks, credit, commodities) reagissent ~3-6 mois avant l''économie réelle — Claude doit décaler l''analyse",
    "Cost of capital bas = favorise buybacks, M&A, capex à faible rendement, zombies companies",
    "Wealth effect du QE est concentré sur les détenteurs d''actifs — contribue aux inégalités",
    "Le ''Fed put'' devient auto-réalisateur : investors achètent la baisse en anticipant l''intervention",
    "Sortir du QE est structurellement DIFFICILE (cf. taper tantrum 2013, QT 2018) — asymétrie politique"
  ]'::jsonb,

  '[
    "2008 QE1 était expérimental et mal compris — toute intervention future a moins de surprise",
    "Les marchés ont intégré le ''Fed put'' dans les valuations — une absence de QE attendu peut tuer une rally",
    "L''effet marginal des QE successifs décroît (QE2, QE3 moins impactants que QE1 sur les rendements)",
    "Le contexte inflation est crucial : QE fonctionne en régime désinflation (2008-2020), devient contradictoire en régime inflation (2022+)",
    "Une nouvelle crise avec inflation élevée ne pourra PAS être traitée par QE sans casser le régime d''inflation (cf dilemme Fed mars 2020 → inflation 2022)",
    "BCE / BoJ ont leur propre contrainte : dette souveraine massive au bilan limite la marge de manœuvre"
  ]'::jsonb,

  array[
    'monetary_easing',
    'regime_shift_monetary',
    'central_bank_balance_sheet',
    'policy_shift',
    'liquidity_injection',
    'debasement_narrative',
    'reflation_trade'
  ]::text[],

  'critical',
  'excellent',

  '[
    {"type":"paper","title":"Large-Scale Asset Purchases by the Federal Reserve","authors":"Gagnon, Raskin, Remache, Sack","year":2011,"publisher":"Federal Reserve"},
    {"type":"speech","title":"Monetary Policy and Open Market Operations","authors":"Ben S. Bernanke Jackson Hole","year":2012},
    {"type":"paper","title":"The Macroeconomic Effects of Large-Scale Asset Purchase Programmes","authors":"Chen, Curdia, Ferrero","year":2012,"publisher":"Bank of England"},
    {"type":"paper","title":"QE: Unconventional Monetary Policy in Theory and Practice","authors":"BIS Working Paper","year":2018},
    {"type":"book","title":"Stress Test: Reflections on Financial Crises","authors":"Timothy Geithner","year":2014,"publisher":"Crown"},
    {"type":"data","title":"Federal Reserve H.4.1 (balance sheet)","publisher":"Federal Reserve"}
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
