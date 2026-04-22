-- Migration 0038 — Corpus micro 5.3 : Yen Carry Unwind (août 2024)
--
-- 5 août 2024 : Nikkei -12% single day (pire depuis 1987). BOJ hike surprise
-- + weak US jobs déclenchent unwind massif du yen carry trade (~250 Md$ notional).
-- $670Md$ wiped out global en une séance.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'yen_carry_trade_unwind_2024_august',
  'Yen Carry Trade Unwind + Global Volatility Spike (August 2024)',
  'fx_crisis',
  '2024-07-31',
  '2024-08-09',
  '10 jours de BOJ hike à stabilisation — choc principal 5 août',
  'Le 31 juillet 2024, la Banque du Japon (BOJ) surprend les marchés en relevant son taux directeur de 0-0.1% à 0.25% (premier hike majeur depuis 2007). Ueda Kazuo (gouverneur) accompagne d''un message hawkish + annonce de tapering QQE. Le yen s''apprécie immédiatement de 154 à 150 USD/JPY. Le 2 août, US jobs report faible : +114k NFP vs 175k attendu, unemployment 4.3% (Sahm Rule triggered = signal recession). Double shock : Fed pivot dovish anticipé + BOJ hike = convergence taux = pression massive yen carry unwind. Le 5 août 2024 (lundi) : Topix et Nikkei 225 plongent -12.4% en une seule séance (pire depuis Black Monday 1987). VIX spike à 65 intraday (3ème plus haut historique après 2008 et COVID). S&P 500 -3% dans la séance. Yen apprécie à 141 USD/JPY (de 161 mi-juillet = +12% en 3 semaines). Mécanique : carry trades ~250 Md$ notional (estimated BIS) borrowed en yen, invested dans high-yielders (MXN, BRL, ZAR) + US tech stocks + crypto. Quand yen apprécie + US rates fall → stop-losses cascade, deleveraging systémique. Nvidia -6% dans la panique. Bitcoin -18% en 24h ($68k → $49k). $670 Md$ de valeur marchée volatilisés en une séance. BOJ Deputy Governor Shinichi Uchida intervient 7 août avec message rassurant (''won''t raise rates when markets unstable''). Ueda confirme 8 août. Marchés récupèrent rapidement : Nikkei +10% le 6 août, fully recover sous 2 semaines. Pattern : liquidation forcée massive + intervention BC verbale = ''flash crisis'' sans dommage systémique durable. Préfigure fragilités FX carry persistante.',

  '[
    "31 juillet 2024 : BOJ hike 0-0.1% → 0.25% + message hawkish + annonce tapering QQE",
    "2 août 2024 : US NFP +114k vs 175k attendu, unemployment 4.3% (Sahm Rule triggered)",
    "5 août 2024 : Nikkei 225 -12.4% (-4,451 pts) en une séance — pire depuis Black Monday 19 oct 1987",
    "USD/JPY : 161 (10 juillet) → 141 (5 août) = +12% yen en 3 semaines",
    "VIX intraday spike 65.73 (5 août) — 3ème plus haut histoire après 2008 + COVID",
    "Topix -12% même séance",
    "$670 Md$ market cap volatilisé 5 août single session (estimated)",
    "Yen carry trade notional ~$250-500 Md$ (BIS estimate) deleveraged",
    "Shinichi Uchida BOJ Deputy Governor intervention verbale 7 août : ''won''t raise rates when markets unstable''",
    "Nikkei récupère +10% le 6 août (biggest gain since 2008)",
    "Recovery complète Nikkei sous 2 semaines",
    "NVDA -6%, BTC -18% ($68k → $49k), Solana -28%",
    "Cross-currency ripples : MXN peso -12% en une semaine, BRL -8%, ZAR -5%"
  ]'::jsonb,

  '[
    "BOJ last rate hike significant était 2007 — 17 ans de ZIRP/NIRP",
    "Yen carry trade re-emerging post-COVID : yen weakness 2022-2024 avec Fed hiking vs BOJ dovish",
    "USD/JPY from 114 (Jan 2022) à 161 (juillet 2024) = -30% yen on carry dynamics",
    "BOJ pressures : inflation japonaise >2% target depuis 18 mois, yen weakness impopulaire (imports inflation)",
    "Fed hawkish retraite : multiple dot-plot revisions 2024 — cuts attendus dès sept 2024",
    "Sahm Rule (unemployment 3m avg +0.5pp from 12m low) trigger historically = recession imminent",
    "Positioning FX carry overcrowded : CFTC data showing net yen short positions record",
    "Japanese households + institutions massively allocated US tech equities (NISA scheme expanded 2024)",
    "Wait-and-see approach BOJ abandoned — Ueda hawkish posture croissante printemps-été 2024",
    "Speculative bubble certaine equities japonaises (Nikkei ATH 42k en mars 2024)"
  ]'::jsonb,

  '{
    "equity_japan_nikkei_225": {
      "pre_event_level": 38800,
      "aug_5_low": 31458,
      "aug_5_drop_pct": -12.4,
      "aug_6_recovery_pct": 10.2,
      "recovery_time_days": 15,
      "notes": "Nikkei 225 -12.4% single session le 5 août — pire depuis Black Monday 19 oct 1987 (-14.9%). Recovery quick."
    },
    "equity_japan_topix": {
      "aug_5_drop_pct": -12.2,
      "notes": "Topix similar magnitude loss"
    },
    "fx_usdjpy": {
      "pre_event_level": 161.7,
      "trough_level": 141.7,
      "trough_date": "2024-08-05",
      "move_pct": -12.4,
      "notes": "USD/JPY de 161.7 (peak juillet) à 141.7 (5 août) = yen apprécie +12% en 3 semaines. Largest 3-week move in decades."
    },
    "equity_us_sp500": {
      "aug_5_drop_pct": -3.0,
      "aug_5_intraday_drop_pct": -4.3,
      "7day_drawdown_pct": -8.5,
      "recovery_days": 30,
      "notes": "S&P 500 -3% le 5 août. -8.5% peak-to-trough 7 jours. Recovery 30 jours."
    },
    "vix": {
      "pre_event_level": 18.6,
      "intraday_peak": 65.73,
      "close_level_aug_5": 38.6,
      "close_date": "2024-08-05",
      "notes": "VIX intraday 65.73 (3ème plus haut histoire). Close 38.6 — still dramatic. Rapid mean revert"
    },
    "bitcoin": {
      "pre_event_level_usd": 68000,
      "aug_5_low_usd": 49000,
      "drawdown_pct": -28,
      "recovery_days": 15,
      "notes": "BTC -28% en 48h — corrélation risk-on maximum en stress. $68k → $49k"
    },
    "equity_nvidia": {
      "aug_5_drop_pct": -6,
      "7day_drawdown_pct": -18,
      "notes": "NVDA flagship AI trade hit dans deleveraging global. Recovery rapide"
    },
    "fx_mxn_mexican_peso": {
      "week_move_pct": -12,
      "notes": "MXN favorite carry trade (high yielder) hit massively. Peso de 17.2 to 19.5 USD/MXN"
    },
    "fx_brl_brazilian_real": {
      "week_move_pct": -8,
      "notes": "BRL similar dynamic — other high yielder"
    },
    "yen_carry_trade_notional": {
      "pre_event_estimate_usd_bn": 500,
      "estimated_unwound_usd_bn": 250,
      "notes": "BIS + academic estimates : ~500Md$ total yen carry, ~250Md$ unwound in August week"
    }
  }'::jsonb,

  '{
    "before": "Yen carry trade massive et rampant, VIX low, positioning crowded risk-on, BOJ perceived as dovish indefinitely, Fed hawkish persistence assumed.",
    "after": "Yen carry trade discredited temporairement puis re-établi au niveau plus prudent. BOJ hike path confirmé mais cautious. BOJ communication sensitivity à markets increased. Fed cutting cycle commence septembre 2024 (-50bps). BOJ vs Fed rate differential narrows structurellement. Lessons sur positioning asymétrique reinforced. Flash crashes (2010, 2015 SNB, 2019 flash yen, 2024 yen carry) pattern recognized : microstructure stress via positioning crowded + central bank surprise."
  }'::jsonb,

  'Recovery complète sous 3 semaines pour la plupart des assets. BOJ maintient hawkish bias mais agit prudemment : second hike +25bps le 19 décembre 2024 (taux 0.5%), third hike janvier 2025 à 0.5%. Fed cuts 50bps septembre 2024, 25bps nov, 25bps déc 2024 = 100bps total. Yen carry re-establi dans des conditions plus prudentes fin 2024, mais avec leverage moindre. Pattern August 2024 servira de template pour futures flash crises yen-driven. Analyses post-mortem : BIS paper (2024), Fed Reserve Vilnius (2024), BOJ Market Review.',

  '[
    "Yen carry trade est la plus grande source de liquidité FX mondiale — son unwind impacte GLOBAL markets",
    "BOJ rate decisions historiques (2007, 2024) : tempo très lent mais choc chaque hike significatif",
    "Positioning asymétrique crowded (net short yen record) = setup pour flash unwind",
    "Convergence double catalyst : BOJ hike + Fed dovish pivot = effect multiplicatif",
    "Sahm Rule (unemployment signal) peut catalyser Fed re-pricing en 48h",
    "Flash crises FX = microstructure + forced liquidations + stop-losses cascade",
    "Central bank verbal intervention (BOJ Uchida) peut stabiliser en quelques heures sans rate action",
    "Recovery patterns après flash crashes : typically 2-4 weeks, V-shape, no lasting damage si fondamentaux intacts",
    "Cross-asset contagion : yen stress → Japanese equities → US tech → BTC → MXN/BRL/ZAR",
    "Carry trade notional (~$500Md$) = leverage implicit dans système — source de vol persistante",
    "BOJ gradualism post-crisis : learned to hike modérément + communication rassurante",
    "Pattern applicable : toute convergence inattendue banques centrales = risk event potential"
  ]'::jsonb,

  '[
    "Post-août 2024, yen carry trade re-établi avec moins de leverage — moins vulnérable à la répétition identique",
    "BOJ a appris communication sensitivity — futures hikes télégraphiées plus longuement",
    "MAIS : structural yen weakness (JP demographics + debt 260% PIB) limite BOJ normalization speed",
    "Pattern flash crash FX persist — prochain trigger pourrait être différent (CNY devaluation, SNB, etc.)",
    "Risk-on positioning (AI stocks, crypto, EM high-yielders) restera vulnérable à liquidity shocks",
    "Fed-BOJ rate differential path clé : narrowing continue 2025 mais slowly",
    "Global deleveraging episodes durent typically 1-3 semaines max (2010 Flash, 2015 SNB, 2019 yen, 2024 carry) — tradable"
  ]'::jsonb,

  array['fx_crisis','carry_trade_unwind','boj_hike','flash_crash','positioning_unwind','global_contagion','vix_spike','sahm_rule','deleveraging_cascade','yen_strength']::text[],

  'warning',
  'excellent',

  '[
    {"type":"paper","title":"BIS Bulletin 90: The market turbulence and carry trade unwind of August 2024","publisher":"Bank for International Settlements","year":2024,"url":"bis.org/publ/bisbull90.pdf"},
    {"type":"speech","title":"Press Conference, Ueda Kazuo","publisher":"Bank of Japan","year":2024},
    {"type":"article","title":"The Wildest Monday in Recent Memory","publisher":"Wall Street Journal","year":2024},
    {"type":"paper","title":"Carry Trade Unwinds and Global Market Volatility","authors":"Fed Reserve Bank of NY","year":2024},
    {"type":"report","title":"BOJ Monetary Policy and Market Developments","publisher":"Bank of Japan","year":2024}
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
