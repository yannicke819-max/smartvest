-- Migration 0033 — Corpus micro 4.6a : Terra/Luna Collapse (mai 2022)
--
-- Effondrement de l''algo-stablecoin UST et de sa crypto jumelle LUNA.
-- 40 Md$ volatilisés en 1 semaine. Trigger event du crypto winter 2022.
-- Pattern ''stablecoin depeg → death spiral'' appliqué à grande échelle.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, source_references
) values (
  'terra_luna_collapse_2022_may',
  'Terra UST Stablecoin Depeg + LUNA Hyperinflation Collapse',
  'systemic_crisis',
  '2022-05-07',
  '2022-05-13',
  '~6 jours de la dépeg initiale à l''effondrement complet (hyperinflation LUNA)',
  'Terra UST (TerraUSD) était un stablecoin algorithmique conçu par Do Kwon (Terraform Labs) pour maintenir sa parité 1:1 USD via un mécanisme mint/burn avec LUNA. Apr 2022 : UST 18 Md$ market cap, 4ème stablecoin mondial. Le 7 mai 2022, de gros retraits de UST du pool Anchor Protocol (offrait 20% APY irréaliste) déclenchent une pression vendeuse. Le 9 mai UST passe à $0.65. Death spiral s''active : pour restaurer peg, protocole BURN UST et MINT LUNA. Mais UST panic selling génère émission massive de LUNA → LUNA hyperinflation. De 340M LUNA à 6.5 TRILLION LUNA en 4 jours. LUNA prix : 119$ (5 avril) → $0.0001 (13 mai). Market cap LUNA : 41 Md$ → zéro. UST : $1 → $0.10. Luna Foundation Guard vend son trésor BTC (80k BTC pour ~3 Md$) pour défendre peg — échoue. Total destruction ~40 Md$. Contagion immédiate : Celsius Network (CEX/lender) pause retraits 12 juin, Three Arrows Capital (3AC, hedge fund $10B AUM) liquidé juin-juillet, Voyager Digital bankrupt 5 juillet. BTC $40k (avant Luna) → $18k (juin). Do Kwon arrêté Montenegro mars 2023, extradé US 2024. Classe action lawsuits, SEC charges.',

  '[
    "Anchor Protocol offrait 20% APY sur UST — return impossible à long terme, financé par subventions Luna Foundation",
    "UST = algorithmic stablecoin, pas collatéralisé USD réel — vulnerability structurelle",
    "Death spiral mechanism : UST down → mint LUNA pour restaurer peg → LUNA inflation → LUNA crash → more UST mint → hyper",
    "Luna Foundation Guard (LFG) avait 80000 BTC reserves (~3 Md$) — vendus en défense du peg, échec",
    "UST market cap peak 18 Md$ (avril 2022) — 4th largest stablecoin",
    "LUNA supply : 340M (avant) → 6.5 TRILLION (après) = 20000x expansion",
    "Large wallet withdrew 85M UST Curve pool 7 mai — premier trigger documenté",
    "Do Kwon bravado public (''I don''t debate the poor'') avant crash — perte crédibilité post",
    "Kwon proposed hard fork ''Terra 2.0'' mai 2022 — flop"
  ]'::jsonb,

  '[
    "Crypto bull 2021 → everyone chasing yield — 20% Anchor était irrésistible",
    "Stablecoin market cap total 180 Md$ début 2022 (USDT 83B, USDC 52B, UST 18B, BUSD 17B)",
    "Fed hiking cycle démarré mars 2022 → liquidity withdrawal global",
    "Crypto BTC déjà -40% du peak 69k en novembre 2021 — bearish backdrop",
    "Précédents algo-stablecoin failures ignored : Iron Titanium 2021, Basis Cash, Empty Set Dollar",
    "UST cross-chain bridges expansion rapide Q1 2022 → contagion vectors multiplied",
    "3AC Zhu Su + Kyle Davies publics sur long LUNA — hedge fund $10B AUM totally exposed"
  ]'::jsonb,

  '{
    "ust_stablecoin": {
      "pre_event_peg": 1.00,
      "lowest_price": 0.04,
      "lowest_date": "2022-05-13",
      "pre_event_mcap_usd_bn": 18.0,
      "post_event_mcap_usd_bn": 0.2,
      "notes": "UST passe de $1 à $0.04 en 6 jours. Depeg irreversible."
    },
    "luna_token": {
      "pre_event_price_usd": 119,
      "ath_price_usd": 119.18,
      "ath_date": "2022-04-05",
      "trough_price_usd": 0.0001,
      "trough_date": "2022-05-13",
      "drawdown_pct": -99.99,
      "pre_event_supply_millions": 340,
      "post_event_supply_trillions": 6.5,
      "supply_expansion_x": 20000,
      "mcap_destroyed_usd_bn": 40,
      "notes": "LUNA plus grand drawdown % crypto histoire sur mid-cap (hors scam tokens). 40Md$ market cap wiped."
    },
    "bitcoin": {
      "pre_ust_depeg_usd": 40000,
      "post_ust_trough_usd": 18000,
      "trough_date": "2022-06-18",
      "drawdown_pct": -55.0,
      "notes": "BTC directement impacté : LFG sold 80k BTC (3Md$) défense peg, market saturé. Bottom $17567 juin."
    },
    "ethereum": {
      "pre_event_usd": 2700,
      "trough_usd": 880,
      "trough_date": "2022-06-18",
      "drawdown_pct": -67.0,
      "notes": "ETH -67% peak-to-trough 2022. DeFi exposure exacerbe"
    },
    "3ac_three_arrows": {
      "pre_event_aum_usd_bn": 10.0,
      "luna_exposure_usd_mn": 560,
      "collapse_date": "2022-06-29",
      "notes": "3AC long GBTC discount + long LUNA + leveraged. Wound-down by court order juin. Zhu Su + Kyle Davies en fuite."
    },
    "celsius_network": {
      "pre_event_aum_usd_bn": 25.0,
      "pause_withdrawals_date": "2022-06-12",
      "chapter11_date": "2022-07-13",
      "notes": "Celsius lending platform 25Md$ AUM — pause retraits 12 juin, bankruptcy 13 juillet. Recovery uncertain clients."
    },
    "voyager_digital": {
      "chapter11_date": "2022-07-05",
      "3ac_exposure_usd_mn": 650,
      "notes": "Voyager lent 650M$ à 3AC sans collatéral adequate. Chapter 11."
    },
    "total_crypto_mcap": {
      "pre_event_usd_tn": 1.7,
      "trough_usd_tn": 0.75,
      "trough_date": "2022-11-14",
      "drawdown_pct": -55.0,
      "notes": "Total crypto mcap 1.7T → 750Md (-55%). Puis FTX en novembre accentue"
    }
  }'::jsonb,

  '{
    "before": "Algorithmic stablecoins perçus comme innovation valide. UST = ''success story'' crypto. 20% yields Anchor normalisés. Crypto hedge funds leveraged extremely. Stablecoins considérés comme risk-free cash equivalent.",
    "after": "Algo-stablecoins discrédités — FRAX pivot vers collatéralisé. Régulateurs (US Treasury, EU MiCA) scrutent stablecoins. USDC et USDT gain market share (collatéralisés). Crypto lending discredited — Celsius, BlockFi, Voyager all bankrupt. CeFi domain destroyed, DeFi on-chain transparency favorisée."
  }'::jsonb,

  'UST, LUNA effectively zero. Do Kwon ''Terra 2.0'' fork mai 2022 (LUNA2 + LUNC legacy) — flop. Kwon fugitif, arrêté Montenegro mars 2023, extradé US octobre 2024 (fraud charges). Contagion cascades juin-juillet 2022 (3AC, Celsius, Voyager) puis accalmie jusqu''à FTX novembre 2022 (voir micro 4.6b). Crypto bottom final BTC $15500 novembre 2022. Recovery lente 2023, puis BTC ETF janvier 2024 (voir micro 5.x) = next cycle.',

  '[
    "Algorithmic stablecoins sont STRUCTURELLEMENT fragiles — death spiral mathematical certainty sous stress",
    "Yields excessifs (20% UST) sont subventionnés temporairement — toujours ''trop beau pour être vrai''",
    "Depeg d''un stablecoin = événement binaire — si UST casse, plus jamais retrouve le peg",
    "Contagion crypto ne respecte pas les narratives : protocole X fail → lenders dégagent collatéral partout → cascade",
    "Centralized crypto lenders (Celsius, BlockFi, Voyager) sans reserves transparentes = ponzi-like structures",
    "Hedge funds crypto (3AC) mélangent strategies long/short et lending — failure mode en cascade",
    "BTC est correlated mais pas immune — quand whale force-sells pour defense (LFG 80k BTC), market impact direct",
    "DeFi on-chain composability amplifie contagion (Anchor → Curve → Aave → Compound)",
    "Regulatory reaction lag 12-18 mois — MiCA EU finalisé 2023, GENIUS Act US 2025",
    "Founders charisma pre-crash est rarely contrôlable ex-post — Do Kwon, SBF, Trevor Milton similarité",
    "Stablecoin collatéralisé ≠ algo-stablecoin : USDC/USDT different risk profile"
  ]'::jsonb,

  '[
    "Algo-stablecoins era terminée — FRAX pivoted, DAI collatéralisé multi-asset, nouveaux algo concepts marginaux",
    "Crypto lending CeFi effondré — BlockFi, Celsius, Voyager out. DeFi (Aave, Compound) survivent avec overcollatéralisation",
    "Contagion crypto en 2025 limitée vs 2022 : moins d''inter-dépendance CeFi, plus DeFi transparent",
    "Stablecoin regulation pas uniforme globally — tail risks persist dans juridictions non-réglementées",
    "Pattern ''yield trop haut = ponzi-like'' applicable à beaucoup d''autres strategies (Anchor 20%, HEX, Luna-like)"
  ]'::jsonb,

  array['crypto_collapse','algorithmic_stablecoin','depeg','hyperinflation','contagion','leverage_unwind','defi_cefi_crisis','ponzi_dynamics']::text[],

  'critical',
  'excellent',

  '[
    {"type":"report","title":"On-Chain Analysis of the UST Depeg","authors":"Chainalysis","year":2022},
    {"type":"article","title":"Terra''s Fall: A 60 Billion Dollar Crypto Crash","publisher":"The Wall Street Journal","year":2022},
    {"type":"paper","title":"Stablecoin Risks and Regulation","authors":"Bank for International Settlements","year":2022},
    {"type":"book","title":"Number Go Up: Inside Crypto''s Wild Rise and Staggering Fall","authors":"Zeke Faux","year":2023,"publisher":"Crown Currency"},
    {"type":"indictment","title":"US v. Do Kwon","publisher":"SDNY","year":2023}
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
