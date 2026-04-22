-- Migration 0040 — Corpus micro 5.5 : GLP-1 Obesity Drugs Revolution (2022-2025)
--
-- Ozempic (Novo Nordisk) + Mounjaro/Zepbound (Eli Lilly) = révolution
-- médicale obesité. Novo + Lilly passent $1T+ valuation combined.
-- Retailers food/beverage hit par anticipation demand destruction.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'glp1_obesity_drugs_revolution_2022_2025',
  'GLP-1 Obesity Drugs Revolution (Ozempic, Mounjaro, Zepbound)',
  'tech_shock',
  '2022-06-01',
  '2025-12-31',
  'Phase inflection 2022 (Wegovy approved), acceleration 2023-2025',
  'Les GLP-1 agonistes (glucagon-like peptide-1) ont transformé le traitement obésité et diabète — première ''weight-loss miracle drug'' scientifiquement validée. Novo Nordisk''s Semaglutide : Ozempic (diabète, approved 2017) + Wegovy (obesité, approved 4 juin 2021, mainstream adoption 2022-2023). Eli Lilly''s Tirzepatide : Mounjaro (diabète, mai 2022) + Zepbound (obesité, novembre 2023). Efficacité : 15-20% poids perte (vs 5-10% pour génération précédente). 2023 : tweets Elon Musk + celebrities (Oprah, Golshifteh Farahani, Khloe Kardashian) viralise culturellement. TikTok #Ozempic >2 Md views. Demand exceeds supply chronic 2023-2024. Revenus Novo Nordisk 2024 : $42Md Ozempic + $4Md Wegovy = $46Md combined. Eli Lilly Mounjaro 2024 : $11.5Md, Zepbound $4.9Md. Novo market cap : $300Md (2021) → $600Md (sept 2023, largest EU company) → $540Md (2025 post competition concerns). Eli Lilly : $250Md (2021) → $800Md (2024 peak, USA largest pharma) → $630Md (2025 after compounding pharmacies FDA ruling + competition). Market implications massive : (1) food/beverage sector déclin anticipé (Walmart CEO comment 2023 : ''seeing lower basket sizes'' on GLP-1 users — stock Walmart +20% YoY, food sector underperform) ; (2) fast food, snacks, alcohol companies downgraded (Coca-Cola, PepsiCo, McDonald''s) ; (3) insulin pumps, glucose monitors (DXCM, MDT) under pressure ; (4) bariatric surgery companies (ISRG, Johnson & Johnson Ethicon) ; (5) anti-obesity adjacent : Dietary supplements declining, plus-size clothing retailers hit. Long-term implications cardiovascular (SELECT trial, New England Journal of Medicine August 2023 : Wegovy reduces heart attacks 20%), Alzheimer''s (ongoing trials), addiction (anecdotal), PCOS... = expanding indication universe. Regulatory : FDA tablets supply shortage 2023, compounding pharmacies fill gap, FDA rules against compounding 2024. Medicare/Medicaid coverage debate. Global availability uneven (supply constrained Europe). Pipeline 2025 : oral semaglutide Rybelsus expansion, triple agonist retatrutide (Lilly), amycretin etc. = next gen coming.',

  '[
    "Wegovy (Novo Nordisk semaglutide) FDA approved obesity June 4, 2021",
    "Mounjaro (Eli Lilly tirzepatide) FDA approved diabetes May 13, 2022",
    "Wegovy mainstream viral : Elon Musk tweet octobre 2022 ''Ozempic Fasting''",
    "Zepbound (Lilly tirzepatide) FDA approved obesity November 8, 2023",
    "Zepbound beats Wegovy head-to-head trial 2024 : -20.2% vs -13.7% weight loss",
    "Novo Nordisk revenues : $25Md (2021) → $35Md (2023) → $46Md (2024)",
    "Eli Lilly revenues : $28Md (2021) → $34Md (2023) → $45Md (2024)",
    "Novo market cap peak $604Md septembre 2023 (largest EU company ever)",
    "Eli Lilly market cap peak $830Md août 2024 (largest pharma global)",
    "SELECT trial NEJM August 2023 : Wegovy reduces MACE 20% (cardiovascular events)",
    "Walmart Doug McMillon comment August 2023 : ''lower basket sizes'' GLP-1 users",
    "FDA shortage semaglutide designated October 2022 — compounded GLP-1 boom",
    "FDA rule contre compounding semaglutide February 2025 — litigation ongoing",
    "Pipeline next-gen : Retatrutide (triple agonist 24% weight loss), Amycretin (oral Novo)"
  ]'::jsonb,

  '[
    "Obesity crisis globally : 42% US adults obese (CDC 2020)",
    "GLP-1 receptor discovered 1980s, first agonist exenatide approved 2005 (diabetes)",
    "Semaglutide weekly formulation breakthrough 2017 (Ozempic)",
    "Previous obesity drugs failed safety/efficacy : Fen-Phen, Meridia, Belviq withdrawn",
    "Diabetes market mature pre-GLP-1 ($60Md global) — incremental market",
    "Obesity estimated addressable market $100Md+ globally",
    "Social media influence TikTok 2022-2023 amplifies",
    "Celebrity endorsements (Oprah reveal 2023) mainstream culture",
    "Insurance coverage patchy initial (Medicare denied obesity coverage pre-2024)"
  ]'::jsonb,

  '{
    "novo_nordisk_nvo": {
      "pre_event_mcap_usd_bn": 300,
      "peak_mcap_usd_bn": 604,
      "peak_date": "2023-09-08",
      "2025_mcap_usd_bn": 540,
      "pre_event_price_usd": 73,
      "peak_price_usd": 139,
      "return_pct": 90,
      "notes": "Novo +90% peak. Overtook LVMH as Europe''s largest company 2023."
    },
    "eli_lilly_lly": {
      "pre_event_price_usd": 235,
      "peak_price_usd": 972,
      "peak_date": "2024-08-23",
      "peak_mcap_usd_bn": 830,
      "return_pct": 314,
      "notes": "Lilly +314% — from $235 to $972. Largest pharma by market cap globally at peak."
    },
    "obesity_market_revenue_combined": {
      "2022_usd_bn": 3,
      "2024_usd_bn": 30,
      "2030_estimate_usd_bn": 150,
      "notes": "Obesity drug market $3Md (2022) → $30Md (2024) → $150Md forecast 2030 (Goldman Sachs estimate)"
    },
    "food_beverage_impact_anticipated": {
      "kraft_heinz_underperform_pct": -15,
      "mondelez_underperform_pct": -10,
      "coca_cola_2024_underperform": "Flat vs S&P +23%",
      "pepsico_2024_underperform": "-1% vs S&P +23%",
      "notes": "Anticipatory selloff food/beverage sectors — demand destruction narrative"
    },
    "fast_food_impact": {
      "mcdonalds_flat_2024": true,
      "yum_brands_modest_gains": true,
      "notes": "Fast food relatively resilient — GLP-1 users still eat but less. Portion sizes pressure"
    },
    "snacks_alcohol": {
      "mondelez_underperform": true,
      "constellation_brands_flat": true,
      "brown_forman_stz_underperform_pct": -25,
      "notes": "Wine/spirits hit — GLP-1 reduces alcohol cravings anecdotally"
    },
    "medtech_impact": {
      "dexcom_dxcm_drop_pct": -35,
      "medtronic_flat": true,
      "insulet_podd_drop_pct": -30,
      "notes": "Glucose monitors, insulin pumps anticipated to lose share if Type 2 diabetes declines"
    },
    "bariatric_surgery_stocks": {
      "intuitive_surgical_isrg_impact": "Minimal — procedures still increasing initially, then flat",
      "notes": "Bariatric surgery procedure volumes levelled off 2024 — surgery now ''last resort'' vs GLP-1 first line"
    },
    "plus_size_retailers": {
      "torrid_drop_pct": -60,
      "notes": "Plus size clothing retailers hit — market size declining"
    },
    "insurance_coverage": {
      "medicare_obesity_coverage_added_2024": true,
      "medicare_monthly_cost_usd": 1300,
      "notes": "Medicare begins obesity drug coverage 2024 — huge addressable market expansion"
    },
    "compounding_pharmacy_impact": {
      "hims_hers_gains_pct": 450,
      "notes": "HIMS telehealth compounding GLP-1 surge 2023-2024. Then FDA rule against compounding February 2025 → stock -40%."
    },
    "side_sectors_beneficiary": {
      "fitness_apparel_lululemon": "Positive (healthier consumers gym focus)",
      "high_end_travel": "Positive (aesthetic motivations)",
      "notes": "Second-order effects on ''aspirational lifestyle'' spending"
    }
  }'::jsonb,

  '{
    "before": "Obesity treated as lifestyle/willpower issue medically. Previous drugs failed. Bariatric surgery last resort. Diabetes market stable $60Md. Food/bev sectors stable growth.",
    "after": "Obesity as treatable chronic disease — new standard of care. Pharma industry reoriented toward chronic lifestyle drugs. Food/beverage sectors structurally impacted (demand destruction). Healthcare costs long-term reduced (cardiovascular, Alzheimer''s prevention). Insurance + government payer coverage expanding. Pipeline drugs for every indication expanding. Global public health shift potential — obesity rates peaking."
  }'::jsonb,

  'GLP-1 revolution continues 2025-2030 : pipeline triple agonists (retatrutide), oral formulations (Rybelsus, amycretin), new indications (Alzheimer, addiction, PCOS). Competition expanding — Roche, Amgen, Pfizer entering with different molecules. Generic/biosimilar threats post-2030 (semaglutide patent expiry 2033). Insurance coverage normalizing. Side-effect profile emerging (muscle loss, long-term unknown). Long-term impact on food sector estimated 2-5% revenue drag. Ozempic/Wegovy becoming household names. Weight loss procedure landscape restructured (bariatric surgery volumes declining after 2024 peak).',

  '[
    "Pharma blockbuster drugs peuvent redéfinir sectors entières — GLP-1 impact extends food, retail, medtech",
    "Second-order effects (demand destruction adjacent sectors) parfois plus gros que primary beneficiary — Walmart comment shifted food stocks",
    "Social media + celebrity endorsement = rapid cultural adoption catalyst (TikTok #Ozempic, Oprah, Musk)",
    "Supply shortage (FDA semaglutide désignation) creates distortions — compounding pharmacies fill gap temporarily",
    "Pipeline depth matters : Lilly retatrutide (24% weight loss) + amycretin next gen = moat expansion",
    "Cross-indication expansion (cardiovascular, Alzheimer, addiction) = 10x addressable market over time",
    "Insurance coverage unlock step-function revenue growth — Medicare 2024 opened US market",
    "Patent cliffs : semaglutide 2033, tirzepatide 2036 — long runway but finite",
    "Competition comes : Roche, Amgen, Pfizer entering — market share wars 2026-2030 likely",
    "Side effects long-term unknown : muscle loss, bone density, potential new issues over 10+ year use",
    "Weight loss + behavioural change = addictive-like economics (lifelong use required, stop = regain weight)",
    "Pharma mega-caps outperform biotech sector — 2023-2024 outlier performance driven by small number of companies",
    "GLP-1 = thesis ''ingredient stocks'' like : peptide CMOs (Novo outsourced), vial manufacturers, cold chain logistics"
  ]'::jsonb,

  '[
    "Post-2025, market saturation + competition slowing growth rates",
    "Biosimilars approach 2033-2036 — long-term margin pressure",
    "Food/beverage sector has begun adapting (reformulations, smaller portions, functional foods)",
    "Retail impact durability uncertain — early adopters may revert, long-term data needed",
    "Cardiovascular/Alzheimer data timing uncertain — clinical trial-dependent",
    "Supply chains now more developed — less shortage disruption futures",
    "Compounding pharmacy workaround now closed (FDA 2025) — generic approach more conventional",
    "Analog : 1990s statins revolution similarly reshaped pharma sector + cardiovascular indications",
    "Pattern : true blockbuster drugs reshape entire sector expectations — rare event"
  ]'::jsonb,

  array['tech_shock','pharma_blockbuster','obesity_revolution','demand_destruction_adjacent','novo_nordisk','eli_lilly','glp1','food_sector_impact','medtech_impact','social_media_catalyst','public_health_shift']::text[],

  'watch',
  'excellent',

  '[
    {"type":"paper","title":"Semaglutide and Cardiovascular Outcomes in Obesity","authors":"Lincoff et al SELECT trial","year":2023,"publisher":"New England Journal of Medicine"},
    {"type":"paper","title":"Tirzepatide Once Weekly for the Treatment of Obesity","authors":"Jastreboff et al SURMOUNT-1","year":2022,"publisher":"New England Journal of Medicine"},
    {"type":"report","title":"GLP-1 Impact on Food and Beverage Sector","publisher":"Goldman Sachs Research","year":2024},
    {"type":"filing","title":"Novo Nordisk Annual Report","publisher":"Novo Nordisk","year":2024},
    {"type":"filing","title":"Eli Lilly 10-K","publisher":"SEC EDGAR","year":2024},
    {"type":"report","title":"The Ozempic Era","publisher":"The Economist","year":2023}
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
