-- Migration 0034 — Corpus micro 4.6b : FTX / Alameda Research Collapse (nov 2022)
--
-- Effondrement de la 2ème exchange crypto mondiale (FTX) + hedge fund
-- affilié (Alameda). Révélation de fraude massive : 8 Md$ customer funds
-- transférés à Alameda. SBF arrêté. Crypto bottom final 2022.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'ftx_alameda_collapse_2022_november',
  'FTX Exchange + Alameda Research Fraud Collapse',
  'credit_event',
  '2022-11-02',
  '2022-11-14',
  '~12 jours de la publication CoinDesk sur Alameda balance sheet à la bankruptcy Chapter 11',
  'FTX (Sam Bankman-Fried ''SBF'') était la 2ème exchange crypto mondiale (après Binance) avec 1M+ clients, $32B valuation Jan 2022. Alameda Research était son hedge fund affilié (créé AVANT FTX par SBF + Caroline Ellison). Le 2 novembre 2022, CoinDesk publie leaked Alameda balance sheet : 14.6 Md$ actifs dont 3.66 Md$ de FTT (FTX''s own token, circular) et 2.16 Md$ de ''FTT collatéral''. Le 6 novembre, Binance CEO CZ (Changpeng Zhao) tweete que Binance liquide sa position FTT (500M$). Panic selling FTT : $22 → $15 en heures. SBF tente de rassurer (''FTX is fine, assets are fine''). FTX bank run massive : retraits 6 Md$ en 72h. Le 8 novembre, FTX pause retraits. Binance annonce intention d''acheter FTX — due diligence rapidement abandonnée le 9 novembre (''beyond our ability to help''). Le 10 novembre, Caroline Ellison (Alameda CEO) avoue en meeting interne que FTX avait secrètement financé Alameda via customer deposits. Le 11 novembre 2022, FTX + 134 affiliates file Chapter 11 bankruptcy. John Ray III (Enron liquidator) nommé CEO — déclare ''never in my career have I seen such a complete failure of corporate controls''. SBF arrêté Bahamas 12 décembre 2022, extradé US, trial octobre 2023, convicted all 7 counts fraud, conspiracy, money laundering. Sentenced 25 ans (mars 2024). Caroline Ellison plea deal, 2 ans. FTX customer losses ~8 Md$. Le crash met fin au crypto winter 2022 avec BTC bottom $15500 le 21 novembre. Chapter 11 restructuration en cours 2024-2025, recoveries estimées 100%+ grâce rally crypto post.',

  '[
    "CoinDesk leak Alameda balance sheet 2 novembre 2022 — 3.66 Md$ FTT + 2.16 Md$ ''FTT collatéral'' révélés",
    "Binance CZ tweet 6 novembre : ''We decided to liquidate our FTT'' = 500M$ sell — panic trigger",
    "FTX customer withdrawals 6 Md$ en 72h (6-8 novembre) — bank run classique",
    "Alameda borrowed 8-10 Md$ customer FTX deposits secretly — ''backdoor'' in FTX code per John Ray III",
    "Binance LOI d''acquisition 8 novembre, retrait 9 novembre après quick due diligence",
    "Caroline Ellison meeting interne 10 novembre : admet que FTX funded Alameda with customer money",
    "Chapter 11 filing 11 novembre 2022 : FTX Trading Ltd + 134 affiliates",
    "Alameda leverage Q1 2022 : ~3x → 11x après Luna losses",
    "SBF political donations documentées : 40M$ 2022 midterms + dark money — relations bipartisan extensive",
    "FTX investor losses : Sequoia 214M$, Tiger Global 38M$, Temasek 275M$, BlackRock 24M$, SoftBank 100M$, Ontario Teachers 95M$"
  ]'::jsonb,

  '[
    "Terra/Luna collapse mai 2022 → Alameda massive losses jamais public (estimated 4+ Md$)",
    "FTX $32B valuation Series C janvier 2022 — peak valuations crypto ever",
    "SBF ''effective altruism'' narrative crédibilité + political access",
    "Relations incestueuses FTX/Alameda depuis fondation — Alameda CFO puis FTX CEO même personnes",
    "FTT tokenomics circular : 33% revenues FTX buyback-and-burn FTT → create artificial scarcity",
    "Alameda balance sheet Q2 2022 déjà toxic — 100% FTT/SOL/SRM concentrations",
    "Crypto yields 20%+ encore offered par FTX Earn, Voyager, Celsius ignore lessons mai 2022",
    "Binance + FTX compétition intense tout 2022 — rivalité CZ/SBF documentée"
  ]'::jsonb,

  '{
    "ftt_token": {
      "pre_event_price_usd": 24,
      "pre_event_mcap_usd_bn": 3.0,
      "trough_price_usd": 1.22,
      "drawdown_pct": -95,
      "notes": "FTT effectively zero après Chapter 11. Holders wiped."
    },
    "bitcoin": {
      "pre_event_level_usd": 21000,
      "trough_level_usd": 15500,
      "trough_date": "2022-11-21",
      "drawdown_pct": -26,
      "notes": "BTC -26% en 10 jours sur FTX saga. Final bottom crypto winter 2022."
    },
    "ethereum": {
      "pre_event_level_usd": 1580,
      "trough_level_usd": 1080,
      "drawdown_pct": -32,
      "notes": "ETH -32% sur la séquence"
    },
    "solana": {
      "pre_event_level_usd": 32,
      "trough_level_usd": 9,
      "drawdown_pct": -72,
      "notes": "SOL particulièrement fracassé — Alameda/FTX étaient les plus gros SOL holders + validators. Panic sur ecosystem dump"
    },
    "total_crypto_mcap": {
      "pre_event_usd_bn": 1040,
      "trough_usd_bn": 750,
      "drawdown_pct": -28,
      "notes": "Total crypto market cap -28% en 2 semaines"
    },
    "ftx_customer_funds_lost": {
      "initial_shortfall_usd_bn": 8.0,
      "customers_affected_count": 1000000,
      "notes": "1 million clients, 8 Md$ shortfall initial. Ultimately recoveries 100%+ grâce rally crypto 2023-2024 + recoveries assets"
    },
    "bitcoin_miners_stocks": {
      "marathon_mara_drawdown_pct": -45,
      "riot_riot_drawdown_pct": -50,
      "coinbase_coin_drawdown_pct": -45,
      "notes": "Mining + CEX stocks devastated — COIN from 70 to 32 en novembre"
    },
    "crypto_venture_impact": {
      "sequoia_loss_usd_mn": 214,
      "tiger_global_loss_usd_mn": 38,
      "temasek_loss_usd_mn": 275,
      "blackrock_loss_usd_mn": 24,
      "ontario_teachers_loss_usd_mn": 95,
      "notes": "Sophisticated VCs and pension funds wiped on FTX. Due diligence post-mortem embarrassant"
    },
    "contagion_failures": {
      "blockfi_chapter11": "2022-11-28",
      "genesis_suspends": "2022-11-16",
      "silvergate_bank_stressed": "Q4 2022 → fermeture mars 2023",
      "signature_bank_stressed": "Q4 2022 → failure mars 2023 post-SVB",
      "notes": "BlockFi filed Chapter 11 16 jours après FTX. Silvergate Bank et Signature Bank en stress — contagion crypto-banking"
    }
  }'::jsonb,

  '{
    "before": "Crypto CEXs self-regulated, proof-of-reserves optionnel, commingling customer/corporate funds commun, SBF vu comme ''poster boy'' crypto mainstream, political + VC credibility max.",
    "after": "Proof-of-reserves MANDATORY pour tous les CEXs. Customer asset segregation strict. Regulatory scrutiny x10 (SEC cases multiples, CFTC, DOJ). Political crypto advocacy déplombé. Effective altruism movement décrédibilisé. MiCA EU + FIT21 US accélèrent. Binance dominant mais aussi scrutinized (settlement DOJ 4.3 Md$ novembre 2023). DeFi on-chain transparency favorisée vs CeFi."
  }'::jsonb,

  'Chapter 11 en cours 2024-2025. FTX recoveries estimées 100%+ grâce à : (1) rally crypto post-BTC ETF janv 2024, (2) seized assets (SOL, Anthropic equity notamment — FTX avait $500M Anthropic series A qui valait $1.4 Md 2024), (3) clawbacks SBF personal + political donations. SBF convicted novembre 2023 — sentenced 25 ans mars 2024. Caroline Ellison 2 ans (coopération). Gary Wang 2 ans. Nishad Singh pas encore sentenced. FTX 2.0 rumeur plusieurs fois — abandonné. Binance pays $4.3B DOJ settlement + CZ step down CEO novembre 2023, pleads guilty. Crypto recovers 2023-2024 : BTC $15k → $100k (voir micro 5.x).',

  '[
    "Les CEXs non-régulés peuvent commingler client funds sans aucune détection externe — SBF l''a fait 3 ans",
    "Charismatic founder + ''effective altruism'' narrative peut masquer fraude structurelle longtemps",
    "Token ponzinomics : créer un token, le buyback with revenues = artificial scarcity + wealth creation. Tenable tant que narrative dure.",
    "Balance sheet circularity (Alameda holdings = FTT = FTX equity = Alameda assets) = red flag majeur",
    "Proof-of-reserves (PoR) devient mandatory industry standard post-FTX",
    "VC due diligence crypto était catastrophique 2021-2022 : $32B valuation without real audit",
    "Investor pressure peut catalyser fraud detection (CZ tweet = événement déclencheur, pas découverte indépendante)",
    "Customer deposit commingling = crime fédéral même en crypto — SBF convicted on 7 counts",
    "Contagion crypto-banking réelle : Silvergate, Signature banks failed mars 2023 partly due to crypto client losses",
    "Political donations via fraud money : SBF 2e plus gros donor D 2022 cycle — clawbacks difficiles",
    "Recovery post-bankruptcy peut dépasser 100% si underlying assets rallient — FTX creditors bénéficient BTC $100k",
    "Regulatory vacuum attire les Do Kwon et SBF — clear rules necessary pour legitimate industry"
  ]'::jsonb,

  '[
    "Post-FTX, major CEXs (Binance, Coinbase, Kraken, OKX) publient proof-of-reserves — moins de cas similaire probable",
    "MiCA EU (décembre 2024) + FIT21 US en cours → customer segregation mandatée",
    "BUT : offshore exchanges + mid-tier crypto lenders peuvent encore commingler fonds — PoR pas universal",
    "Pattern founder charisma → fraude persiste (Trevor Milton Nikola, Elizabeth Holmes Theranos, SBF, Do Kwon)",
    "Contagion crypto-banking crisis 2023 (SVB, Silvergate, Signature) peut se répéter si concentration clients crypto-heavy"
  ]'::jsonb,

  array['crypto_fraud','exchange_collapse','customer_fund_commingling','ponzi_dynamics','founder_fraud','proof_of_reserves','ceFi_crisis','contagion','bank_run','chapter_11']::text[],

  'critical',
  'excellent',

  '[
    {"type":"article","title":"Divisions at Crypto Giant FTX","publisher":"CoinDesk","year":2022,"url":"coindesk.com"},
    {"type":"court_filing","title":"FTX Chapter 11 Voluntary Petitions","publisher":"Delaware Bankruptcy Court","year":2022},
    {"type":"indictment","title":"US v. Samuel Bankman-Fried","publisher":"SDNY","year":2022},
    {"type":"book","title":"Going Infinite: The Rise and Fall of a New Tycoon","authors":"Michael Lewis","year":2023,"publisher":"W.W. Norton"},
    {"type":"book","title":"Number Go Up","authors":"Zeke Faux","year":2023,"publisher":"Crown Currency"},
    {"type":"report","title":"First Interim Report of John J. Ray III","publisher":"FTX Trading Ltd","year":2023}
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
