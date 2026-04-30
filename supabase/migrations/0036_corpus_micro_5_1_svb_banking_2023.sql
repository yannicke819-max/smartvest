-- Migration 0036 — Corpus micro 5.1 : SVB Collapse + Regional Banking Crisis (mars 2023)
--
-- Silicon Valley Bank failure 10 mars 2023 = 2ème plus grosse bank failure
-- US histoire ($209B assets). Trigger crise banking régional : Signature,
-- First Republic, Credit Suisse UBS. Fed Bank Term Funding Program.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, source_references
) values (
  'svb_regional_banking_crisis_2023',
  'SVB Collapse + US Regional Banking + Credit Suisse UBS Crisis',
  'systemic_crisis',
  '2023-03-08',
  '2023-05-01',
  '~2 mois de SVB wholesale run à First Republic takeover JPM',
  'Le 8 mars 2023, Silicon Valley Bank (SVB) — 17ème plus grosse banque US, $209 Md$ actifs, ''bank of Silicon Valley'' finançant 50% des startups VC-backed — annonce une vente forcée de $21 Md de Treasuries avec $1.8 Md perte + capital raise. Le problème sous-jacent : SVB avait investi massivement (115 Md$) les deposits Covid-era dans long-duration Treasuries à bas rendement en 2020-2021. Quand Fed hike 500bps en 2022, held-to-maturity (HTM) portfolio perd 17 Md$ unrealized — capital effectivement insolvant. Le 9 mars, VC Twitter (Peter Thiel Founders Fund, Y Combinator Garry Tan) recommande aux portfolio companies de withdraw — bank run VIRAL premier de l''ère sociale network. 42 Md$ retirés en 10h (25% des deposits). Le 10 mars 2023, FDIC saisit SVB — 2ème plus grosse bank failure US histoire (après WaMu 2008). Le 12 mars, FDIC + Fed + Treasury annoncent : (1) tous les deposits SVB garantis (même > $250k FDIC limit — bail-out political) ; (2) Signature Bank NY saisie (contagion crypto exposure) ; (3) Bank Term Funding Program (BTFP) : Fed prête at par contre collatéral Treasuries (évite fire sales) ; (4) First Republic Bank reçoit 30 Md$ deposits from 11 big banks. Le 19 mars, Credit Suisse (168-year-old institution, $575B assets) forced acquisition par UBS à $3.25 Md (99.5% discount vs book) — AT1 bonds wiped out ($17 Md, controversial). First Republic finalement failed 1er mai 2023, acquired by JPMorgan pour FDIC-assisted deal. BTFP usage peak $165 Md. Crisis evites l''effet systémique de 2008 mais révèle fragilité duration mismatches dans régional banking post-ZIRP era.',

  '[
    "SVB $209 Md$ assets, 17ème banque US — deuxième plus grosse failure histoire US",
    "HTM portfolio loss : $17 Md unrealized (Treasuries + MBS longs acheté 2020-2021 at 1.5% yield)",
    "Fed hike 500bps en 2022 → duration losses ultra-rapides",
    "Deposit concentration : 93% SVB deposits above FDIC $250k limit (tech concentration)",
    "Bank run viral via social media + VC Twitter — 42 Md$ retirés en 10h = 25% des deposits",
    "Peter Thiel Founders Fund withdraws March 9 → VC recommendation cascade",
    "FDIC saisit SVB 10 mars 2023 9h40 ET — record speed (normalement weekend)",
    "12 mars : FDIC + Fed + Treasury announcement : tous deposits SVB + Signature garantis",
    "Bank Term Funding Program : Fed prête at par contre US Treasuries + agency debt (12-mois)",
    "Credit Suisse AT1 bonds wiped out 17 Md$ 19 mars — shock marchés AT1 globaux",
    "First Republic failed 1er mai → JPMorgan acquisition",
    "BTFP peak usage $165 Md (jan 2024)",
    "Régional bank stocks KBW Regional Banking Index -35% mars 2023"
  ]'::jsonb,

  '[
    "Zero-interest-rate era 2020-2022 : banques gorgées de deposits, low-yield short supply",
    "SVB strategy : buy long Treasuries/MBS pour yield pickup → duration risk massive",
    "2018 Dodd-Frank rollback : banques <$250 Md exemptées liquidity coverage ratio (LCR) strict — SVB just above threshold",
    "CFO SVB vendu $3.6M stock weeks avant failure — insider selling suspicious",
    "Fed hiking cycle depuis mars 2022 → HTM portfolios massive unrealized losses cumulative",
    "Accounting rule : HTM bonds pas mark-to-market au bilan — fiction comptable",
    "Depositor concentration tech/crypto/VC = corrélation uniforme panic behavior",
    "Credit Suisse scandales cumulés 2020-2022 (Archegos, Greensill, money laundering Singapour) — credibility shot",
    "Silvergate Bank liquidation volontaire 8 mars (crypto-concentric) = prequel immediate SVB"
  ]'::jsonb,

  '{
    "svb_silicon_valley_bank": {
      "total_assets_usd_bn": 209,
      "total_deposits_usd_bn": 175,
      "deposits_above_fdic_limit_pct": 93,
      "htm_portfolio_unrealized_loss_usd_bn": 17,
      "bank_run_hours": 10,
      "bank_run_withdrawals_usd_bn": 42,
      "pct_deposits_withdrawn": 25,
      "equity_price_collapse_pct": -97,
      "notes": "Record speed bank run 10h. Equity 266 → 0.01 en 2 jours. Depositors finally made whole (bail-out)"
    },
    "signature_bank": {
      "total_assets_usd_bn": 110,
      "crypto_deposits_exposure_pct": 20,
      "failure_date": "2023-03-12",
      "notes": "Seized Sunday 12 mars — crypto exposure + contagion SVB"
    },
    "first_republic_bank": {
      "total_assets_usd_bn": 230,
      "deposit_flight_usd_bn": 100,
      "interim_rescue_usd_bn": 30,
      "rescue_date": "2023-03-16",
      "final_failure_date": "2023-05-01",
      "jpm_acquisition_price_usd_bn": 10.6,
      "notes": "30 Md$ intervention collective 11 big banks, mais final failure 2 mois après. JPM deal."
    },
    "credit_suisse": {
      "total_assets_usd_bn": 575,
      "forced_merger_date": "2023-03-19",
      "ubs_acquisition_price_usd_bn": 3.25,
      "discount_to_book_pct": 99.5,
      "at1_bonds_wiped_usd_bn": 17,
      "notes": "Swiss Govt + FINMA forced Sunday deal. Controversial AT1 write-down violates traditional capital hierarchy. Lawsuits ongoing."
    },
    "fed_bank_term_funding_program": {
      "launch_date": "2023-03-12",
      "peak_usage_usd_bn": 165,
      "peak_date": "2024-01-24",
      "expired_date": "2024-03-11",
      "terms": "12-month loans at par against US Treasuries + agency debt — avoid fire sales",
      "notes": "BTFP created in 48h post-SVB. Peak usage $165Md en janvier 2024."
    },
    "equity_kbw_regional_bank_index": {
      "pre_event_level": 118,
      "trough_level": 76,
      "peak_drawdown_pct": -35,
      "notes": "KBW Regional Bank Index -35% mars 2023"
    },
    "govt_bonds_us_2y": {
      "pre_event_yield_pct": 4.90,
      "post_event_trough_yield_pct": 3.70,
      "yield_move_bps": -120,
      "notes": "2y Treasury yield -120bps en 5 jours — flight to quality + Fed pivot expectations"
    },
    "govt_bonds_us_10y": {
      "pre_event_yield_pct": 4.08,
      "post_event_trough_yield_pct": 3.37,
      "yield_move_bps": -71,
      "notes": "10y -71bps. Curve steepens as 2y moves more"
    },
    "bitcoin": {
      "pre_event_level_usd": 22000,
      "post_event_level_usd": 28000,
      "daily_return_mar_13_pct": 14,
      "notes": "BTC RALLIES sur banking crisis — narrative ''Bitcoin hedge contre système bancaire'' validated. USDC depegged briefly (Circle had $3.3B at SVB)."
    },
    "gold": {
      "pre_event_level_usd": 1820,
      "post_event_level_usd": 2075,
      "return_pct": 14,
      "notes": "Gold atteint record $2075 mi-mai 2023. Haven flow + banking fragility narrative"
    },
    "usdc_stablecoin_depeg": {
      "pre_event_peg": 1.00,
      "trough_price": 0.87,
      "trough_date": "2023-03-11",
      "duration_hours": 48,
      "notes": "USDC temporary depeg $0.87 - Circle avait 3.3Md$ à SVB. Re-peg après bail-out announcement"
    }
  }'::jsonb,

  '{
    "before": "Regional banks US perçus comme safe post-2008 Dodd-Frank. HTM portfolio accounting tolérée. VC-tech concentration considérée comme edge. AT1 bonds traditionnellement senior aux equity en resolution. Fed path hawkish assumed continuing.",
    "after": "Duration risk banques re-scrutinized. Depositor concentration + social-media speed bank runs = nouveau risque. BTFP créé nouveau outil liquidité. AT1 bonds reprice wider (after Credit Suisse wipeout). Fed hawkish path modérée — pause quickly expected (though continue hikes until juillet 2023). Regional banks deleverage balance sheets aggressively. Commercial real estate concerns amplifiés (regional banks heavily exposed)."
  }'::jsonb,

  'BTFP expire 11 mars 2024 après $165 Md peak usage. Fed continue hikes jusqu''à 5.25-5.50% juillet 2023 (2 hikes post-SVB). Commercial real estate stress persists 2023-2025. New York Community Bancorp (NYCB) en stress janvier 2024 (acquired Signature assets, struggled). First Republic JPM deal = plus gros bank deal depuis 2008. Credit Suisse definitely dead. UBS emerge dominant Swiss bank. Pas de bank failure majeure subséquente 2023-2025 — crise contenue. AT1 market eventually recovers mais spreads wider. Regulatory scrutiny mid-cap banks increases.',

  '[
    "Duration risk ≠ credit risk mais peut casser une banque aussi sûrement — SVB n''avait aucun credit loss, just duration losses",
    "HTM (held-to-maturity) accounting fiction : losses réelles malgré accounting hidden — scrutinize MTM always",
    "Depositor concentration = corrélation parfaite panic behaviour — SVB tech concentration + VC Twitter = perfect storm",
    "Social media peut transformer bank run traditionnel (jours) en flash run (heures) — modèle resilience bancaire à reconsidérer",
    "FDIC $250k limit : fiction comptable politique — dans crise systémique, all deposits protected de facto",
    "Fed BTFP innovation : prête against collatéral at PAR (non-market value) — éviter fire sales mécanisme",
    "AT1 bonds post-Credit Suisse : market reprice spreads wider structurally — Swiss regulator broke ''bail-in'' hierarchy",
    "Regional banks plus vulnérables grandes banques : (1) less regulated post-2018 rollback, (2) concentrations depositor, (3) commercial RE exposure, (4) smaller capital buffers",
    "Post-SVB, Fed pivot expectations pricé — mais Fed continua hikes. Market pricing != Fed action",
    "Crypto bénéficie paradoxalement de banking crisis — narrative alternative asset reinforcée",
    "Bank insider selling (SVB CFO) = red flag avant major events — always watch Form 4 filings",
    "Fast contagion SVB→Signature→FRC→Credit Suisse → mais PAS 2008-style systemic meltdown thanks to BTFP + rapid response"
  ]'::jsonb,

  '[
    "Post-SVB, regional banks ont raccourci duration portfolios + raised capital — moins vulnérables à la même crise",
    "Depositor concentration remains an issue mais plus scrutinized maintenant",
    "BTFP expirée mars 2024 — moins de backstop disponible si nouvelle crise similaire",
    "Commercial real estate legacy continues to stress some banks 2024-2025 (NYCB, etc.)",
    "Large banks structurally stronger post-2023 (deposit inflows from regional banks)",
    "Crisis was CONTAINED — pas systemic. Future banking crises pourraient être plus contained if tools proven",
    "MAIS : if inflation persiste + Fed forced to hike again → duration stress resurface"
  ]'::jsonb,

  array['banking_crisis','duration_risk','bank_run','social_media_contagion','htm_accounting','depositor_concentration','fed_intervention','btfp','at1_bonds','regional_bank','commercial_real_estate','flight_to_quality']::text[],

  'critical',
  'excellent',

  '[
    {"type":"report","title":"Review of the Federal Reserve''s Supervision and Regulation of Silicon Valley Bank","publisher":"Federal Reserve","year":2023},
    {"type":"report","title":"FDIC Review of Silicon Valley Bank Failure","publisher":"FDIC","year":2023},
    {"type":"article","title":"The First Twitter-Fueled Bank Run","publisher":"The Economist","year":2023},
    {"type":"paper","title":"Monetary Tightening and U.S. Bank Fragility in 2023","authors":"Jiang, Matvos, Piskorski, Seru","year":2023,"publisher":"NBER"},
    {"type":"report","title":"UBS Acquisition of Credit Suisse","publisher":"Swiss FINMA","year":2023},
    {"type":"press_release","title":"Bank Term Funding Program","publisher":"Federal Reserve","year":2023}
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
