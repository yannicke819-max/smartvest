-- Migration 0030 — Corpus micro 4.3/6 : GameStop Short Squeeze + Retail Revolution
--
-- Janvier 2021 : coordination r/WallStreetBets + Robinhood retail → short
-- squeeze épique sur GME (+2000% en 2 semaines). Melvin Capital quasi-
-- collapse. Robinhood restreint les achats (trading halt controversé).
-- Marks le début d''une ère où le flow retail peut mover les prix
-- d''entreprises mid-cap mieux que les institutionnels.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'gamestop_meme_stocks_2021_jan',
  'GameStop Short Squeeze + Meme Stocks Retail Revolution',
  'market_stress',
  '2021-01-13',
  '2021-02-04',
  '~3 semaines : montée rapide 13-27 janvier, halt 28 janv, déflation 28 jan - 4 fev',
  'Fin 2020, GameStop (GME) était une company ''left for dead'' : short interest >140% du float (record historique, signe que plus d''actions étaient shortées que l''existant — covered via rehypothecation). Short sellers institutionnels (Melvin Capital, Citron Research) publiaient des thèses bearish publiques. Sur Reddit r/WallStreetBets (2M members fin 2020), des retail traders identifient le setup : si on force un short squeeze, les shorts doivent racheter, propulsant le prix en vertical. Le 13 janvier 2021, le Chairman Ryan Cohen (Chewy founder) annonce un plan de transformation → GME double à $31. Les 22-27 janvier : GME de $40 à $347 en 5 séances. Elon Musk tweete ''Gamestonk!!'' le 26 janvier. Melvin Capital perd 53% en janvier (4.5 Md$), sauvé par Citadel + Point72 qui injectent 2.75 Md$. Autres meme stocks (AMC, BlackBerry, Nokia, Bed Bath & Beyond, Koss) rallient également en sympathie. Le 28 janvier 2021, Robinhood bloque les ACHATS de GME, AMC, etc. (ne permet que les ventes) — citant exigences de clearing capital (DTCC augmente leurs collateral requirements). Controversial : les retail accusent une collusion Robinhood-Citadel (Citadel paye Robinhood pour order flow ET était prêteur de Melvin). Classaction lawsuits, congressional hearings (Vlad Tenev, Gabe Plotkin, Ken Griffin témoignent février 2021). GME clôture à $325 le 28 janvier, chute à $53 le 4 février. Implications durables : short interest devient une donnée scrutée, Robinhood perd confiance (IPO juillet 2021 désastreux), flux retail deviennent systémiques (options call volume explose), narratives ''hedge funds vs retail'' dominent culture crypto/meme 2021.',

  '[
    "GME short interest 140% du float (début janvier 2021) — record historique",
    "r/WallStreetBets 2 millions members (2021) — coordination facilitée via Reddit",
    "Ryan Cohen appointment au board GME (11 janv 2021) — catalyseur fondamental initial",
    "Call options massives achetées par retail → dealers forcés de hedger (gamma squeeze)",
    "GME intraday high $483 (28 jan 2021) vs fundamentals justifiant ~$15",
    "Melvin Capital perte 53% janvier 2021 — rescued 2.75 Md$ par Citadel (2 Md$) + Point72 (750 M$)",
    "Robinhood trading halt 28 jan 2021 : restrict BUY orders sur GME, AMC, BB, NOK, BBBY etc.",
    "DTCC margin requirements increased 10x pour Robinhood le matin du 28 jan",
    "Vlad Tenev (Robinhood CEO) 3 B$ emergency funding capital call",
    "Elon Musk ''Gamestonk!!'' tweet 26 jan à 16h18 — GME +40% after-hours",
    "Citron Research Andrew Left announce abandon short research (20 jan 2021)",
    "Congressional hearings février 18, 2021 + mai 6, 2021"
  ]'::jsonb,

  '[
    "COVID trading boom : Robinhood +13M nouveaux comptes en 2020, commission-free",
    "Stimulus cheques $1200 (avril) + $600 (déc) + $1400 (mars) → ''stimmy'' money flowing to markets",
    "Interest rates à 0% → no return cash, retail pousse vers risk assets",
    "r/WallStreetBets culture : memes, losses posts, ''diamond hands'' mentality, YOLO trades",
    "Short interest data publique via Bloomberg, FINRA → retail peut identifier cibles",
    "Options call volume record : 30M contracts/jour Q4 2020 vs 15M 2019",
    "Réussites précédentes : TSLA short squeeze 2020 (+740%), Kirkland Lake Gold",
    "GME short interest monté à 100%+ depuis Q2 2020 — setup mûri 6 mois avant explosion"
  ]'::jsonb,

  '{
    "gamestop_gme": {
      "january_opening_price": 17.25,
      "peak_intraday_high": 483.00,
      "peak_date": "2021-01-28",
      "peak_close": 347.51,
      "robinhood_halt_close": 193.60,
      "post_halt_low": 38.50,
      "post_halt_low_date": "2021-02-19",
      "peak_return_from_jan_1_pct": 2700.0,
      "notes": "GME de $17 (début janv) à $483 intraday (28 janv) = +2700%. Retour à $53 après halt Robinhood. Puis second rally $350 fin fév (court term). Court-terme oscillations extremes."
    },
    "amc_entertainment": {
      "january_opening": 2.01,
      "peak_january_close": 13.26,
      "return_pct": 560.0,
      "notes": "AMC ride the wave GME. Puis second run juin 2021 jusqu''à $72."
    },
    "other_meme_stocks": {
      "blackberry_bb": "+280% janvier",
      "nokia_nok": "+90% janvier",
      "bed_bath_beyond_bbby": "+135% janvier",
      "koss_koss": "+2400% janvier",
      "express_expr": "+425% janvier",
      "notes": "Short interest stocks rallient en sympathy — pattern ''squeeze candidates''"
    },
    "melvin_capital_impact": {
      "january_2021_return_pct": -53.0,
      "aum_pre_usd_bn": 13.0,
      "emergency_funding_usd_bn": 2.75,
      "notes": "Melvin perd 4.5 Md$ en janvier. Emergency capital from Citadel ($2B) + Point72 ($750M). Finally closes fund mai 2022."
    },
    "citron_research": {
      "impact": "Andrew Left abandonne publication de short theses (20 janv 2021)",
      "notes": "Citron avait publié bearish GME target $20 le 19 janv — harassment massif suite"
    },
    "robinhood_crisis": {
      "dtcc_margin_increase": "Multiplicateur 10x overnight 28 janv",
      "emergency_capital_raise_usd_bn": 3.4,
      "user_lawsuits": "Class actions multiples",
      "ipo_impact": "IPO juillet 2021 à $38, trade à $13 fin 2021 (-65%)",
      "notes": "Robinhood ne s''est jamais totalement remis de la crise de confiance — même si IPO eu lieu"
    },
    "options_market": {
      "call_volume_record_day": "34 millions contracts 27 janv 2021",
      "retail_share_options": "~25% du volume total début 2021 vs ~10% avant",
      "notes": "Retail options flow devient systémique — affecte dealer hedging, ''gamma squeeze'' mechanics"
    },
    "equity_us_large_sp500": {
      "impact_week_jan25_pct": -3.3,
      "notes": "S&P 500 -3.3% semaine 25-29 janvier — deleveraging généralisé hedge funds qui couvrent GME losses en vendant autres positions"
    },
    "equity_short_interest_basket": {
      "high_short_interest_basket_jan_return_pct": 25.0,
      "notes": "Goldman high short interest basket +25% en 2 semaines — squeezes en chaîne"
    },
    "vix": {
      "pre_event_level": 21.9,
      "peak_jan_27_level": 37.2,
      "notes": "VIX spike sur deleveraging puis mean revert"
    }
  }'::jsonb,

  '{
    "before": "Retail traders marginal — considérés ''dumb money'' selon Wall Street. Short sellers institutionnels hegemonic. Robinhood + Citadel payment-for-order-flow considéré comme win-win.",
    "after": "Retail flux systémique — peut déplacer mid-cap stocks mieux que institutions. Short interest publié devient setup signal pour contrarians. Hedge funds courts réévaluent process (moins publics sur thèses, meilleure gestion risk). Robinhood perd réputation — regulatory scrutiny PFOF augmente. Culture ''meme stocks'' établie : crypto-like dynamics sur equities. SEC investigate mais aucune poursuite majeure."
  }'::jsonb,

  'GME retrace à $40-$50 base février-mars 2021. Second run mars 2021 ($340). Puis volatilité chronique pendant 2 ans. GME subsequently splits 4:1 (2022), announce board changes, launche NFT marketplace. Melvin Capital ferme mai 2022. Congressional hearings produisent rapports mais aucune législation substantive. Retail options flow devient feature permanente du market. Pattern se répétera : AMC juin 2021 ($72), BBBY 2022 (meme puis faillite 2023), puis réveil GME sur Roaring Kitty return mai 2024.',

  '[
    "Short interest >100% du float est une bombe à retardement — attention au setup de squeeze",
    "Retail coordination via social media = nouvelle force sur le marché — impossible à ignorer",
    "Gamma squeeze (options call flow) amplifie les movements spot — dealers forcés de hedger en achetant l''action",
    "Payment for order flow (PFOF) crée conflit d''intérêt documenté : Citadel paie Robinhood ET était prêteur de Melvin — trading halt GME était structural (margin), pas collusion, mais perception aura détruit la réputation",
    "Clearing/settlement infrastructure (DTCC T+2) crée margin requirements asymmetrical — broker vulnerable si retail concentre 1 stock",
    "Hedge funds publics sur leurs thèses short = ciblés pour squeezes — moins de thèses publiques depuis",
    "Les fundamentals ne comptent PAS à court terme quand flow technique + sentiment dominent — GME valorisé $25B alors que business vaut $2B",
    "Options market microstructure : dealers short gamma = forced buyers, amplifie up moves",
    "Liquidity crises brokers sur meme stocks = risque retail de être ''deplatformed''",
    "Meme stocks ont comportement crypto-like : high vol, narrative-driven, community-coordinated",
    "Short selling n''est pas mort mais doit être fait discrètement + stricte management risk (stop wider, less leverage)"
  ]'::jsonb,

  '[
    "Regulatory scrutiny PFOF post-2021 (SEC rule proposals) — future GameStop plus dificile à reproduire via Robinhood",
    "DTCC a ajusté margin models — moins de scénarios de ''broker halt'' sur squeeze",
    "Short interest publique désormais checkée par tous — saturation du setup",
    "Hedge funds moins publics sur thèses short — moins de targets publics",
    "r/WallStreetBets a changé (maintenant 18M members mais dilution culturelle)",
    "Retail options flow reste significatif mais plus sophistiqué (moins pure YOLO, plus strategies)",
    "Pattern applicable à d''autres micro/mid caps avec high short interest + retail-friendly narrative",
    "Période ZIRP 2020-2022 + stimmy cash propice → inflation + hikes 2022 ont réduit ce fuel spéculatif"
  ]'::jsonb,

  array['meme_stocks','short_squeeze','retail_coordination','gamma_squeeze','pfof_conflict','options_flow','social_media_market','hedge_fund_crisis','trading_halt','robinhood_crisis']::text[],

  'warning',
  'excellent',

  '[
    {"type":"report","title":"Staff Report on Equity and Options Market Structure Conditions in Early 2021","publisher":"SEC","year":2021},
    {"type":"testimony","title":"Game Stopped? Who Wins and Loses When Short Sellers, Social Media, and Retail Investors Collide","publisher":"House Financial Services Committee","year":2021},
    {"type":"article","title":"The GameStop Saga","publisher":"The New York Times","year":2021},
    {"type":"book","title":"The Antisocial Network","authors":"Ben Mezrich","year":2021,"publisher":"Grand Central"},
    {"type":"paper","title":"Retail Investors and Equity Returns: Evidence from GameStop","authors":"Chague et al","year":2022},
    {"type":"article","title":"The Real Story Behind the Gamestop Short Squeeze","publisher":"Matt Levine Bloomberg","year":2021}
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
