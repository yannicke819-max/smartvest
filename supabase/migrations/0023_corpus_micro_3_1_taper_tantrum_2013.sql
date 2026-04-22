-- Migration 0023 — Corpus micro 3.1/5 : Taper Tantrum (mai-sept 2013)
--
-- Signalement Fed du futur ralentissement du QE → spike violent des
-- taux longs US, contagion EM via flux de portefeuille. Leçon :
-- la RÉDUCTION des politiques accommodantes est PLUS brutale que
-- leur annonce, car positioning asymétrique.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'taper_tantrum_2013',
  'Fed Taper Tantrum',
  'policy_shift',
  '2013-05-22',
  '2013-09-18',
  'Phase aiguë ~4 mois du testimony Bernanke à la décision Fed de NOT tapering (mi-sept)',
  'Le 22 mai 2013, Ben Bernanke en testimony devant le Joint Economic Committee mentionne que la Fed pourrait "dans les prochaines réunions" ralentir (''taper'') les achats QE3 (85 Md$/mois MBS + Treasuries). Les FOMC minutes du même jour confirment. La réaction marchés est brutale et asymétrique : 10y Treasury yield passe de 1.63% (début mai) à 3.04% (début sept), +141bps en 4 mois. L''impact global est bien plus fort que la réalité du taper : contagion sur EM (capital outflows), commodity weakness, REITs/high dividend stocks sell-off. Le 18 sept 2013, la Fed SURPREND en NE tapering PAS (vs consensus qui attendait le taper) — yields retombent partiellement. Le taper commence finalement en décembre 2013 (Janet Yellen prend le relai en février 2014). Lesson clé : le MARCHÉ price la politique monétaire avec un levier énorme sur les flows mondiaux, parce que le positioning asymétrique (tout le monde long risk grâce à QE) crée un unwind violent au moindre signal contraire.',

  '[
    "Bernanke Congressional testimony 22 mai 2013 — mention ''moderate pace'' tapering",
    "FOMC minutes 22 mai 2013 révèlent débat interne sur le taper",
    "Marchés avaient pricé QE ''infini'' — positioning extrême long duration + EM + risk assets",
    "Contagion FX via carry trade unwind (JPY, CHF funding → EM EM assets)",
    "Capital outflows EM : -40 Md$ de retraits d''ETFs EM bond/equity en juin 2013",
    "Fragile Five émerge comme concept : Turquie, Afrique du Sud, Inde, Indonésie, Brésil (déficits courants + dette USD)"
  ]'::jsonb,

  '[
    "Fed balance sheet atteint 3.3 T$ en mai 2013 (vs 0.9 T$ pré-QE)",
    "10y yield au low 1.61% le 1er mai 2013 — positioning long duration extrême",
    "MSCI EM avait reboundé de +110% depuis 2008 — flows massifs sur ETFs EM",
    "Mortgage rates 30y à 3.35% — demande housing sensible au 10y",
    "Bernanke avait déjà évoqué ''tapering'' dans speeches précédents mais sans réaction marché",
    "FOMC avril 2013 avait été dovish — contraste avec mai amplifie le choc"
  ]'::jsonb,

  '{
    "govt_bonds_us_10y": {
      "pre_event_yield_pct": 1.63,
      "peak_yield_pct": 3.04,
      "peak_date": "2013-09-06",
      "yield_move_bps": 141,
      "notes": "141bps move en 4 mois — l''un des plus brutaux de l''histoire récente hors crise"
    },
    "mortgage_rates_us_30y": {
      "pre_event_pct": 3.35,
      "peak_pct": 4.46,
      "move_bps": 111,
      "notes": "Refinance applications -50% — brief housing market scare"
    },
    "equity_em": {
      "peak_drawdown_pct": -17.5,
      "peak_drawdown_date": "2013-06-24",
      "notes": "MSCI EM de 1055 (mai) à 880 (juin 2013). Capital outflows amplifient"
    },
    "em_fx_fragile_five": {
      "try_turkey_pct": -25.0,
      "zar_south_africa_pct": -20.0,
      "inr_india_pct": -18.0,
      "idr_indonesia_pct": -18.0,
      "brl_brazil_pct": -15.0,
      "notes": "Devises Fragile Five -15 à -25% en 4 mois. Déficits courants creusés."
    },
    "us_reits": {
      "peak_drawdown_pct": -18.0,
      "notes": "REITs (VNQ ETF) -18% mai-juin. High-dividend + rate-sensitive = double whammy"
    },
    "commodities_gold": {
      "peak_drawdown_pct": -21.0,
      "pre_event_level_usd": 1470,
      "trough_level_usd": 1180,
      "notes": "Or -21% — end of decade-long bull. Pattern classique : or souffre de real rates qui montent"
    },
    "fx_dxy": {
      "peak_appreciation_pct": 3.5,
      "notes": "USD modérément up — attrait sur yields qui montent, mais pas crise globale"
    },
    "equity_us": {
      "peak_drawdown_pct": -5.8,
      "notes": "S&P 500 -5.8% brief sell-off début juin mais repart rapidement. US assets + équilibrés que EM."
    }
  }'::jsonb,

  '{
    "before": "QE open-ended perçu comme permanent. Yields long structurellement ancrés bas. EM bénéficient du ''hunt for yield''.",
    "after": "Taper devient la référence de ''policy normalization'' — tous les futurs tapers (2014-2015, 2017-2019 QT, 2022 QT2) seront comparés. EM apprend à gérer flows volatils. Fed adopte ''forward guidance'' plus prudente."
  }'::jsonb,

  'Fed décide le 18 sept 2013 de NE PAS taper (surprise dovish) — yields retombent à 2.6%. Taper commence finalement en décembre 2013 (réduction $10B/mois). Complete fin du QE3 en octobre 2014. Yields remontent graduellement sur 12 mois mais sans deuxième tantrum. EM FX récupère partiellement fin 2013.',

  '[
    "L''annonce de FIN d''une politique accommodante est plus brutale que l''annonce de sa création (asymétrie positioning)",
    "Forward guidance est l''outil le plus puissant mais aussi le plus dangereux : un mot peut déclencher un choc de taux",
    "EM sont le canari dans la mine pour les changements de politique Fed — flows rapides, positioning léger",
    "Fragile Five = pattern (déficit courant + dette USD) qui revient (Turquie 2018, Argentine 2018, EM broad 2022)",
    "La Fed doit ex-ante COMMUNIQUER avec prudence sur tout changement — d''où la pratique Yellen/Powell de télégraphier longtemps à l''avance",
    "Real rates drive gold : gold down quand real rates montent (inverse corrélation structurelle)",
    "Duration risk est asymétrique : on perd plus en duration -50bps move qu''on ne gagne en +50bps move (convexité négative sur certaines structures)"
  ]'::jsonb,

  '[
    "Depuis Taper Tantrum, Fed télégraphie MUCH plus longtemps à l''avance — moins de surprise",
    "Mais positioning reste asymétrique post-QE massive → risque tantrum persiste sur chaque normalisation",
    "2022 tightening a été tel brutal car positioning 2020-2021 ENCORE plus extrême que 2013",
    "EM ont renforcé leurs reserves FX depuis 2013 — moins vulnérables qu''à l''époque (mais encore dépendants)",
    "Pattern applicable à toute banque centrale qui normalise après QE massive"
  ]'::jsonb,

  array['policy_normalization','fed_communication_shock','em_outflows','carry_unwind','duration_risk','fragile_five','positioning_unwind']::text[],

  'warning',
  'excellent',

  '[
    {"type":"speech","title":"Testimony on May 22, 2013","authors":"Ben S. Bernanke","year":2013,"publisher":"Joint Economic Committee"},
    {"type":"paper","title":"The Impact of the Federal Reserve''s Tapering Announcements","authors":"Eichengreen, Gupta","year":2014,"publisher":"IMF"},
    {"type":"paper","title":"EM Capital Flows During Taper Tantrum","authors":"IIF Research","year":2014},
    {"type":"data","title":"FRED Fed Funds & 10y Treasury","publisher":"St. Louis Fed"}
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
