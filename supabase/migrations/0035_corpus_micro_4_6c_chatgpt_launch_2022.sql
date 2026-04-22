-- Migration 0035 — Corpus micro 4.6c : ChatGPT Launch (30 novembre 2022)
--
-- Événement fondateur de la révolution AI generative. Trigger du super-cycle
-- AI boom 2023-2025 qui va porter NVDA +900%, Microsoft +100%, et redéfinir
-- trillion$ de capex infrastructure IA. Plus grande product launch tech
-- depuis iPhone 2007.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, source_references
) values (
  'chatgpt_launch_2022_november',
  'ChatGPT Public Launch + AI Super-Cycle Inception',
  'tech_shock',
  '2022-11-30',
  '2024-06-30',
  'Catalyseur ponctuel 30 nov 2022, effet super-cycle 18+ mois sur equities AI',
  'Le 30 novembre 2022, OpenAI lance publiquement ChatGPT (basé sur GPT-3.5), un chatbot gratuit accessible via navigateur web. Sam Altman tweetait pré-lancement : ''try out talking to chatgpt.com''. En 5 jours, 1 million d''utilisateurs. En 2 mois, 100 millions (fastest consumer product adoption ever, surpassant TikTok, Instagram). Le marché ne réagit PAS immédiatement — ChatGPT est initialement perçu comme curiosité tech. Mais le pivot intervient en janvier 2023 : Microsoft annonce investissement 10 Md$ dans OpenAI (23 janvier), intègre GPT dans Bing. Google panics en février (''Code Red''), lance Bard. Le 22 février 2023, Nvidia earnings Q4 FY23 : guidance +50% (vs consensus +5%) grâce à demande data center AI chips (H100). NVDA +24% le lendemain. Commence un rally qui va faire de NVDA +900% entre début 2023 et juin 2024. La narrative se propage : (a) Magnificent 7 stocks (MSFT, AAPL, NVDA, GOOGL, AMZN, META, TSLA) responsables de 60%+ des gains S&P 500 2023-2024 ; (b) AI infrastructure capex exploding : hyperscalers 2024 $200B+ en AI datacenters ; (c) AI companies valorisées $1T+ (NVDA passe $1T février 2024, $2T juin 2024, $3T octobre 2024) ; (d) Mag 7 PE ratios 35-50x stretched. Launches subsequent : GPT-4 (mars 2023), Claude 2 (juillet 2023), Gemini (déc 2023), Claude 3 Opus (mars 2024), GPT-4o (mai 2024), Llama 3 (avril 2024 open-source), Claude 3.5 Sonnet (juin 2024), o1 reasoning (sept 2024). DeepSeek R1 (janvier 2025) challenge : open-source Chinese model rivaling GPT-4 at 95% less cost → NVDA single-day -17% (27 janv 2025, -$600B mcap, biggest one-day market cap loss history).',

  '[
    "30 novembre 2022 : ChatGPT launch gratuit à chatgpt.com",
    "1M utilisateurs en 5 jours, 100M en 2 mois (record adoption)",
    "Microsoft $10B investment OpenAI (23 janvier 2023) + Bing integration",
    "Google ''Code Red'' février 2023 → Bard launch (échec initial)",
    "NVIDIA Q4 FY23 earnings 22 fév 2023 : guidance +50%, AI chip demand",
    "NVDA rally : $140 (janv 2023) → $1250 (juin 2024 pre-split) = +790%",
    "Hyperscalers capex explosion : MSFT, GOOGL, META, AMZN combined $200Md+ data center 2024",
    "Magnificent 7 (MSFT, AAPL, NVDA, GOOGL, AMZN, META, TSLA) = 30% du S&P 500 market cap, 60% gains 2023-2024",
    "NVDA market cap : $360B (fin 2022) → $3.3T (peak juin 2024) = x9",
    "Anthropic fundraising $4B Amazon + $2B Google (2023-2024) → valuation $18B → $183B (mars 2025)",
    "OpenAI valuation $29B (janv 2023) → $157B (oct 2024) → $300B+ (early 2025)",
    "DeepSeek R1 shock 27 janv 2025 : NVDA -17%, -$600B mcap (record)",
    "Chinese AI Models surge : Qwen, DeepSeek, Moonshot — undermine narrative US AI moat"
  ]'::jsonb,

  '[
    "GPT-3 launch juin 2020 par OpenAI — notable mais pas mainstream",
    "Instruct-GPT paper janvier 2022 — RLHF methodology breakthrough",
    "Stable Diffusion août 2022 — open-source image generation viral",
    "Research transformer architecture 2017 (Attention Is All You Need) — foundation",
    "Pre-chatgpt Nvidia revenue 80% gaming, 20% data center — pivot 2023-2024",
    "Covid-era cloud spending boom 2020-2022 → hyperscaler capex capacity",
    "Semi-conducteur supply chain crise 2021-2022 résolue fin 2022 — disponibilité chips",
    "Compute cost GPT-3 training: ~4.6M$ (2020) — compute became affordable for foundational models"
  ]'::jsonb,

  '{
    "nvidia_nvda": {
      "pre_event_price_usd": 140,
      "peak_price_usd_pre_split": 1250,
      "peak_date": "2024-06-18",
      "ath_return_pct": 790,
      "post_10to1_split_price": 135,
      "mcap_peak_usd_tn": 3.3,
      "mcap_pre_event_usd_bn": 360,
      "notes": "NVDA +790% en 18 mois. 10:1 split juin 2024. Passe AAPL en market cap (2024)."
    },
    "microsoft_msft": {
      "pre_event_price_usd": 243,
      "ath_price_usd": 470,
      "ath_date": "2024-07-08",
      "return_pct": 93,
      "notes": "MSFT dual benefit : Azure OpenAI integration + Copilot monetization."
    },
    "meta_meta": {
      "pre_event_price_usd": 120,
      "ath_price_usd": 740,
      "return_pct": 517,
      "notes": "META rally incroyable post-2022 nadir — ''year of efficiency'' + Llama open-source + AI ads improvements"
    },
    "alphabet_googl": {
      "pre_event_price_usd": 95,
      "ath_price_usd": 207,
      "return_pct": 118,
      "notes": "GOOGL lag initial (ChatGPT search threat narrative), puis rally sur Gemini + cloud. Relative outperformance faible dans Mag 7."
    },
    "amazon_amzn": {
      "pre_event_price_usd": 94,
      "ath_price_usd": 240,
      "return_pct": 155,
      "notes": "AWS AI + Anthropic partnership + e-commerce recovery"
    },
    "tesla_tsla": {
      "pre_event_price_usd": 160,
      "ath_price_usd": 488,
      "notes": "TSLA bounce on FSD + robotaxi narrative, mais volatile et divergent des autres Mag 7"
    },
    "apple_aapl": {
      "pre_event_price_usd": 148,
      "ath_price_usd": 260,
      "notes": "AAPL laggard initial AI, then rally on Apple Intelligence launch juin 2024"
    },
    "mag7_combined_weight_sp500": {
      "pre_event_pct": 20,
      "peak_pct": 33,
      "notes": "Magnificent 7 passe de 20% du S&P 500 (fin 2022) à 33% (été 2024). Concentration record"
    },
    "ai_infra_stocks": {
      "avgo_broadcom_return_pct": 380,
      "amd_return_pct": 180,
      "tsm_taiwan_semi_return_pct": 110,
      "notes": "AI infrastructure picks shovels : Broadcom, AMD, TSMC, SMCI, DELL rally massive"
    },
    "deepseek_r1_impact_jan_2025": {
      "event_date": "2025-01-27",
      "nvda_daily_drop_pct": -17,
      "nvda_mcap_lost_usd_bn": 600,
      "notes": "Plus grande perte market cap une journée de l''histoire. NVDA temporairement perd $600B. Narrative ''AI is cheap open-source'' challenge US AI moat. Récupéré dans les semaines suivantes partiellement."
    },
    "openai_valuation": {
      "jan_2023_usd_bn": 29,
      "oct_2024_usd_bn": 157,
      "early_2025_usd_bn": 300,
      "notes": "OpenAI valuation explosion — private markets AI bubble"
    },
    "anthropic_valuation": {
      "mid_2023_usd_bn": 4.1,
      "dec_2023_usd_bn": 18,
      "mar_2025_usd_bn": 183,
      "notes": "Anthropic similar trajectory — Amazon + Google strategic investments"
    }
  }'::jsonb,

  '{
    "before": "AI était research / enterprise niche. ChatGPT first mainstream generative AI interface. Software-heavy businesses dominantes tech. Nvidia gaming-centric ($360B mcap, 20% data center).",
    "after": "AI devient thème d''investissement dominant 2023-2025. Infrastructure investment cycle le plus gros depuis internet 1999 (estimated $1T+ hyperscaler capex 2024-2026). Nvidia devient le ''picks and shovels'' trade — $3T+ mcap. Software multiples compressed (growth slower but stable) vs AI beneficiaries. Foundation model race (OpenAI vs Anthropic vs Google vs Meta vs DeepSeek) = new oligopoly. Compute shortage drives energy demand → utilities + nuclear stocks rally (Constellation Energy, Vistra). Labor market AI automation debate active."
  }'::jsonb,

  'Super-cycle AI continue 2024-2025 avec divergence : compute plateau possible (scaling laws questioned, GPT-5 delayed), mais inference/reasoning compute demands exploser (o1, Claude 3.7). DeepSeek R1 janvier 2025 révèle que capabilities peuvent être reproduites à fraction du coût — NVDA hit court terme mais recovery. Capex hyperscalers 2025 atteint $250-300B. Mag 7 concentration pose risques systémiques (53% S&P 500 gains 2024). Valuations stretched : NVDA 40x forward, MSFT 35x, GOOGL 25x. IPOs AI (CoreWeave 2025, possible OpenAI IPO 2026). Regulatory scrutiny AI growing (EU AI Act, US executive orders).',

  '[
    "Adoption consumer tech peut être exponentielle une fois product-market fit trouvé — 100M users en 2 mois",
    "Infrastructure providers (NVDA ''picks and shovels'') outperform service providers (OpenAI app layer) dans tech cycles early",
    "Mega-cap tech concentration explode in AI cycle → S&P 500 beta tirée par 7 stocks",
    "Incumbents peuvent rebounder puissamment si on AI (META year-of-efficiency), ou laguer (AAPL, GOOGL)",
    "Private AI valuations explode plus vite que public — OpenAI $29B → $300B en 2 ans",
    "AI capex cycle similar to internet infra 1999-2000 — potentially bubble-territory",
    "Tech shock catalysts : une product launch peut créer trillions$ de valeur en 12-18 mois (iPhone 2007, AWS 2006, ChatGPT 2022)",
    "Scaling laws + compute = new moat, but potentially breakable (DeepSeek R1 shock)",
    "Chinese AI progress (DeepSeek, Qwen, Moonshot) challenges ''US AI moat'' narrative",
    "Hyperscalers compétition datacenter location/power → utility + nuclear stock rally side-effect",
    "Foundation model vs vertical AI debate — enterprise AI still finding revenue models",
    "Defense sector integrates AI massively — Palantir, Anduril, Helsing — geopolitical implications"
  ]'::jsonb,

  '[
    "AI super-cycle UNIQUE dans son ampleur et rapidité — pas de précédent exact (internet 1999 closest)",
    "NVDA concentration risque : 10%+ du S&P 500, pivotal pour index returns. Un reverse = broad correction",
    "Scaling laws contestés 2024-2025 : GPT-5 delayed, o1 reasoning = different paradigm. Compute-heavy expansion possibly slowing",
    "DeepSeek January 2025 = rappel que open-source + efficient peut disrupt — future shocks possible",
    "Capex cycle typical : infra boom → capacity oversupply → returns compressed — watch 2026-2027 pour correction",
    "Regulatory risk (antitrust Alphabet, EU AI Act compliance) croissant — pas encore pricé dans valuations",
    "Labor displacement impact économique réel pas encore visible — AGI timeline uncertain",
    "Chine export restrictions sur advanced chips (H100, H200) → Chinese AI diverge — fragmentation tech stack"
  ]'::jsonb,

  array['tech_shock','ai_revolution','generative_ai','platform_inflection','mega_cap_concentration','magnificent_7','infrastructure_capex_cycle','picks_and_shovels','chatgpt_moment','foundation_models','compute_bottleneck']::text[],

  'watch',
  'excellent',

  '[
    {"type":"press_release","title":"Introducing ChatGPT","publisher":"OpenAI","year":2022,"url":"openai.com/blog/chatgpt"},
    {"type":"paper","title":"Training language models to follow instructions with human feedback","authors":"Ouyang et al","year":2022,"publisher":"OpenAI"},
    {"type":"paper","title":"Attention Is All You Need","authors":"Vaswani et al","year":2017,"publisher":"Google"},
    {"type":"earnings_call","title":"NVIDIA Q4 FY23 Earnings","publisher":"NVIDIA","year":2023},
    {"type":"article","title":"The AI Capex Boom","publisher":"Financial Times","year":2024},
    {"type":"paper","title":"Scaling Laws for Neural Language Models","authors":"Kaplan et al","year":2020,"publisher":"OpenAI"},
    {"type":"technical_report","title":"DeepSeek-R1","publisher":"DeepSeek","year":2025}
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
