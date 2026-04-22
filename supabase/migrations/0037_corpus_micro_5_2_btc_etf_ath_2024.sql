-- Migration 0037 — Corpus micro 5.2 : BTC Spot ETF Approval + Halving + ATH $126k
--
-- Janvier 2024 SEC approuve 11 spot BTC ETFs. Avril 2024 4th halving.
-- Cycle bull 2024-2025 porte BTC de $42k à $126k peak octobre 2025.
-- Institutional adoption mass via iShares Bitcoin Trust (IBIT) atteint
-- $80 Md$ AUM en 18 mois (fastest ETF ever).

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'bitcoin_spot_etf_halving_ath_2024_2025',
  'Bitcoin Spot ETF Approval + 4th Halving + ATH $126k Cycle',
  'tech_shock',
  '2024-01-10',
  '2025-10-06',
  '21 mois de l''approbation ETF à l''ATH cycle octobre 2025',
  'Le 10 janvier 2024, la SEC approuve simultanément 11 spot Bitcoin ETFs après 10+ ans de rejets (Gensler votes contre mais confirme 3-2 majority). Émetteurs : BlackRock (IBIT), Fidelity (FBTC), ARK 21Shares (ARKB), Bitwise (BITB), VanEck, WisdomTree, Invesco Galaxy, Valkyrie, Franklin Templeton, Grayscale GBTC conversion, Hashdex. Trading démarre 11 janvier 2024. Flows sans précédent : IBIT atteint $10 Md en 7 semaines (record fastest ETF). GBTC (Grayscale) voit $21 Md outflows janv-mars 2024 (conversion from trust vers ETF + profit-taking post-decade-long discount). Net flows cumulés tous BTC ETFs : +$50 Md à fin 2024, +$125 Md à octobre 2025. Impact prix : BTC $42k (10 janv 2024) → $73k (14 mars 2024) pre-halving rally. 4ème halving le 19 avril 2024 : block reward 6.25 → 3.125 BTC (supply émission annuelle 2% → 1%). BTC consolidation H2 2024, puis rally avec Trump victory novembre 2024 (pro-crypto agenda). BTC franchit $100k le 5 décembre 2024 (première fois histoire, $103,679). Consolidation janv-mai 2025, second rally : BTC touche $126,198 le 6 octobre 2025 = ATH absolu. Institutions massives : MicroStrategy $26 Md BTC corporate treasury (500k+ BTC), Tesla réaffirme holdings, 78% Fortune 500 exploring blockchain/crypto (Q2 2025 per research). Central banks autour (El Salvador, Bhutan) + sovereign wealth funds BTC allocations publicly announced 2025. Companies publiques BTC treasury strategy : >100 2025. ETH spot ETF approved juillet 2024 (similar trajectory mais magnitude moindre). Solana, XRP ETFs approval expected 2025-2026.',

  '[
    "10 janvier 2024 : SEC approuve 11 spot BTC ETFs (3-2 vote split)",
    "Trading démarre 11 janvier 2024 : $4.6 Md volume premier jour (record ETF history)",
    "IBIT (BlackRock) : $0 → $80 Md AUM en 21 mois — fastest ETF $ en histoire",
    "GBTC outflows : $21 Md en 2 mois (conversion profit-taking + lower fees concurrents)",
    "Net flows cumulés BTC ETFs : +$125 Md à octobre 2025",
    "19 avril 2024 : 4ème halving Bitcoin — block reward 6.25 → 3.125 BTC",
    "BTC $100k franchi 5 décembre 2024 ($103,679)",
    "BTC ATH cycle $126,198 le 6 octobre 2025",
    "Trump victory 5 novembre 2024 + pro-crypto administration (SEC chair Paul Atkins, crypto task force)",
    "GENIUS Act (stablecoin regulation) signed 2025 — clarity regulatory",
    "ETH spot ETF approved 23 juillet 2024 — similar institutional flow dynamic",
    "MicroStrategy : 500k+ BTC corporate treasury ($26 Md valuation 2025)",
    "Saylor ''21M program'' : MSTR convertible debt issuance to fund BTC purchases",
    "Sovereign + corporate BTC allocations surge 2025"
  ]'::jsonb,

  '[
    "SEC previously rejected BTC spot ETF 20+ times 2013-2023",
    "Grayscale v SEC lawsuit August 2023 : DC Circuit rules SEC rejection ''arbitrary and capricious''",
    "Winter crypto 2022 (Luna, FTX) terminée, BTC bottom $15k novembre 2022",
    "BTC $30k → $42k fin 2023 sur anticipation ETF approval",
    "BlackRock Larry Fink pivot : from ''index of money laundering'' (2017) à ''international digital gold'' (2023)",
    "Global macro : Fed pause hike 2023, anticipation cuts 2024 — favorable risk-on",
    "Narrative ''BTC = digital gold'' + ''ETF = boomer access'' combined",
    "MicroStrategy pioneer : Saylor commence BTC corporate treasury août 2020",
    "2022-2023 régulateurs hostiles (Gensler SEC, Gary Gensler Class Action Operation Choke Point 2.0)",
    "2024 élection year avec crypto vote bloc documenté"
  ]'::jsonb,

  '{
    "bitcoin_price_cycle": {
      "etf_approval_price_usd": 46000,
      "etf_approval_date": "2024-01-10",
      "pre_halving_peak_usd": 73750,
      "pre_halving_peak_date": "2024-03-14",
      "halving_price_usd": 64000,
      "halving_date": "2024-04-19",
      "100k_breakthrough_usd": 103679,
      "100k_breakthrough_date": "2024-12-05",
      "ath_peak_usd": 126198,
      "ath_peak_date": "2025-10-06",
      "return_from_etf_launch_pct": 174,
      "notes": "BTC +174% de l''approbation ETF jan 2024 à ATH oct 2025. Cycle classique halving + 18 mois."
    },
    "ibit_blackrock_etf": {
      "launch_date": "2024-01-11",
      "aum_7_weeks_usd_bn": 10,
      "aum_1year_usd_bn": 55,
      "aum_october_2025_usd_bn": 80,
      "notes": "IBIT plus rapide ETF à atteindre $50Md AUM jamais. Record historique"
    },
    "all_btc_etfs_combined": {
      "net_inflows_cumulative_usd_bn": 125,
      "number_of_etfs": 11,
      "combined_aum_usd_bn": 180,
      "notes": "11 ETFs, $180Md combined AUM. Unprecedented institutional access"
    },
    "gbtc_grayscale_outflows": {
      "first_3_months_outflows_usd_bn": 21,
      "pre_etf_discount_pct": -20,
      "post_etf_discount_pct": 0,
      "notes": "GBTC trust converted to ETF → profit-taking decade-long discount holders. Outflows $21B initial."
    },
    "ethereum_spot_etfs": {
      "approval_date": "2024-07-23",
      "launch_day_volume_usd_bn": 1.1,
      "cumulative_inflows_2024_usd_bn": 3,
      "cumulative_inflows_mid_2025_usd_bn": 18,
      "notes": "ETH spot ETFs launched juillet 2024. Smaller flows vs BTC mais significant"
    },
    "ethereum_price": {
      "pre_etf_usd": 3480,
      "ath_2025_usd": 4878,
      "notes": "ETH benefits but magnitude less than BTC. Merging narratives DeFi + staking yield"
    },
    "microstrategy_mstr": {
      "btc_holdings_pre_2024": 189000,
      "btc_holdings_oct_2025": 510000,
      "stock_price_pre_etf": 55,
      "stock_price_peak_2024": 473,
      "return_pct": 760,
      "notes": "MSTR outperform BTC spot par leverage. $26Md BTC corporate treasury. Joins S&P 500."
    },
    "coinbase_coin": {
      "pre_event_usd": 150,
      "ath_usd": 370,
      "return_pct": 147,
      "notes": "COIN primary beneficiary — custodian pour plusieurs ETFs"
    },
    "mining_stocks": {
      "mara_return_pct": 120,
      "riot_return_pct": 80,
      "clsk_return_pct": 250,
      "notes": "Miners outperform mais volatility massive. AI/HPC diversification narrative"
    },
    "solana_price": {
      "pre_event_usd": 110,
      "ath_2025_usd": 293,
      "return_pct": 166,
      "notes": "SOL benefits from meme season 2024-2025 + potential ETF approval 2025"
    },
    "total_crypto_mcap": {
      "etf_approval_usd_tn": 1.7,
      "ath_cycle_usd_tn": 4.5,
      "notes": "Total crypto $4.5T ATH cycle 2025"
    }
  }'::jsonb,

  '{
    "before": "BTC considéré ''speculative asset'', ETF rejected 20+ times, corporate treasury exotic (MSTR only), institutional adoption slow, regulatory hostility US (Operation Choke Point 2.0, Gensler SEC).",
    "after": "BTC devient mainstream institutional asset class. $180Md+ ETF AUM. Corporate treasury adoption >100 companies. Sovereign wealth fund allocations. Trump admin pro-crypto. Regulatory clarity GENIUS Act + FIT21. BTC integrated in portfolio allocation discussions (2-5% typical advisor recommendation). ''Digital gold'' narrative consolidated. Custody infrastructure institutional-grade (Coinbase, Anchorage, Fidelity Digital)."
  }'::jsonb,

  'Cycle bull continues 2025. ATH $126k octobre 2025 avec targets analystes $150-200k fin 2026 (JPM, Standard Chartered). Halving cycle paradigm questioned (ETF flows dominant supply/demand vs halving). Corporate treasury trend : 100+ companies public BTC balance sheet 2025. Nation-state adoption : El Salvador (full legal tender 2021), Bhutan mining, Argentina debate. Sovereign wealth funds : Norges Bank + middle east SWF rumored allocations. Regulatory pro-crypto : Paul Atkins SEC 2025, Crypto Task Force. Stablecoins regulated (GENIUS Act 2025). Side effects : energy demand mining sector, nuclear stocks rally (Constellation, Vistra).',

  '[
    "Regulatory approval can unlock decades of institutional demand in months — BTC ETF flows $125Md in 21 months",
    "ETF wrapper = gateway for traditional money — boomer access via 401k/IRA/brokerage",
    "Halving cycles predictably reduce supply issuance, but ETF flows may break cycle rhythm — 2024-2025 already deviated from pure 4-year cycle",
    "Corporate treasury adoption : MSTR pioneer, others follow — ''BTC standard'' narrative",
    "Political environment matters — pro-crypto admin unlocks regulatory progress",
    "Bitcoin correlations : with equity/risk-on during bull, with gold during monetary debasement fears",
    "Leverage products outperform spot in bulls (MSTR 760% vs BTC 174%) — but volatility brutal",
    "Mining stocks highly leveraged to BTC price but added AI/HPC diversification narrative 2024-2025",
    "Ethereum + other altcoins benefit lagging but significantly — layered adoption",
    "Custody infrastructure institutional-grade = precondition for large-scale adoption (insurance, audit)",
    "Network effects BTC : nation-state adoption + corporate treasury + ETF = reflexive price action",
    "Macro sensitivity : Fed pivot dovish = BTC tailwind, hawkish = headwind"
  ]'::jsonb,

  '[
    "2024-2025 cycle unique : first post-ETF cycle, potentially breaks 4-year halving pattern",
    "Mainstream adoption + institutional flows = moins volatile cycles futurs probable",
    "Regulatory clarity = moins de downside from enforcement actions surprise",
    "Sovereign wealth + central bank BTC = tail wind structural",
    "BUT : concentration risk MicroStrategy-style companies — if BTC -50%, MSTR and similar face forced selling",
    "Post-ETF bear markets (if occur) pourraient être plus contenus mais PE Institutional holders peuvent panic sell aussi",
    "Regulatory shifts possible under different admins — Warren-era skeptic return would reverse",
    "Cycle thesis vs ETF flow thesis : tension ongoing. Halving 2028 will test if halving cycle still governs"
  ]'::jsonb,

  array['tech_shock','regulatory_approval','etf_launch','institutional_adoption','halving_cycle','crypto_bull','corporate_treasury','digital_gold','magnificent_inflow','blackrock','microstrategy']::text[],

  'watch',
  'excellent',

  '[
    {"type":"press_release","title":"SEC Approves Spot Bitcoin ETPs","publisher":"SEC","year":2024,"url":"sec.gov"},
    {"type":"report","title":"Bitcoin ETF Market Analysis","publisher":"Chainalysis","year":2024},
    {"type":"paper","title":"The Effects of Bitcoin Halvings on Price","authors":"Various academic","year":2024},
    {"type":"article","title":"BlackRock IBIT Record-Breaking Growth","publisher":"Bloomberg","year":2024},
    {"type":"data","title":"Farside Investors BTC ETF flows","publisher":"Farside Investors"},
    {"type":"speech","title":"Larry Fink Letter to Shareholders","publisher":"BlackRock","year":2024},
    {"type":"filing","title":"MicroStrategy 10-K","publisher":"SEC EDGAR","year":2024}
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
