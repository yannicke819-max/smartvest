-- Migration 0029 — Corpus micro 4.2/6 : Pfizer/BioNTech Vaccine Day
--
-- Le 9 novembre 2020, annonce Pfizer/BioNTech vaccin COVID 90%+ efficace.
-- Le plus grand sector rotation d''une journée : stay-home stocks -10%,
-- value/cyclicals +10%. Pattern : binary medical news → macro regime shift.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'vaccine_day_value_rotation_2020_nov',
  'Pfizer/BioNTech Vaccine Day + Value-Growth Rotation',
  'tech_shock',
  '2020-11-09',
  '2021-05-15',
  'Catalyseur ponctuel 9 novembre 2020, effet rotation sur ~6 mois',
  'Le 9 novembre 2020, 06h45 ET (avant pre-market), Pfizer et BioNTech publient un communiqué : leur vaccin COVID-19 BNT162b2 démontre >90% d''efficacité en phase 3. Le marché réagit violemment : S&P 500 futures +5% pre-market, gap up d''ouverture massif. Mais la grande histoire est la ROTATION SECTORIELLE la plus extrême d''une journée de l''histoire récente. Les ''stay-home stocks'' s''effondrent : Zoom -17%, Peloton -20%, Netflix -8%, Moderna -8% (!). Les ''reopening stocks'' explosent : Carnival Cruise +39%, United Airlines +19%, Boeing +13%, petits retailers physiques +20-30%. Russell 2000 +3.7% vs S&P 500 +1.2% (small caps cyclical dominant). Value vs Growth index +9% en UNE journée — plus gros move jamais. Les yields 10y spike +11bps (3m earlier peak), courbe steepen. Ce qui se passe : 8 mois de surexposition tech + underexposition value/cyclical sont débouclés en un jour. Les hedge funds qui avaient empilé les pair trades ''long tech short value'' (trade gagnant depuis mars) reçoivent une margin call massive. Le mouvement dure 6 mois (nov 2020 - mai 2021) avec Russell 2000 +50%, banques +40%, énergie +60%, pendant que NASDAQ tech stagne. Moderna announce ensuite (16 nov) 94.5%, J&J et AstraZeneca en décembre. ''Reopening trade'' devient le narrative dominant jusqu''à été 2021.',

  '[
    "Pfizer/BioNTech communiqué 09h45 ET 9 nov 2020 — efficacité >90% phase 3",
    "Moderna communiqué 16 nov 2020 — 94.5% efficacité",
    "Biden élu 7 nov 2020 — stimulus additionnel anticipé",
    "Positioning hedge funds avait atteint records : long tech (FAANG), short value (banks, energy, airlines)",
    "Global pair trade ''stay-home vs reopening'' saturé après 8 mois de divergence",
    "Vaccination rollout : premier shot UK 8 déc 2020, US 14 déc 2020",
    "Yields spike : 10y de 0.79% (9 nov pre-open) à 0.96% même jour — +17bps",
    "Small caps Russell 2000 +3.7% le jour — leaders recovery"
  ]'::jsonb,

  '[
    "Phase 3 trials Pfizer/BioNTech lancés été 2020 — marché attendait results fin 2020",
    "Positioning ultra-polarisé : mega-tech growth valorisations records (AAPL 39x PE, TSLA 200x, ZM 450x)",
    "Value/cyclical sectors à valuations historiques basses : banks P/B <1, energy out-of-favor",
    "Vaccine optimism sous-estimé : market prédisait low probability d''efficacité élevée avec mRNA (nouvelle technologie)",
    "Moderna et Pfizer avaient publié phase 2 données positives été 2020 — mais marché sceptique",
    "TSX energy subindex -55% YTD début novembre → contrarian setup extrême",
    "Biden victoire 7 nov amplifie narrative reflation (stimulus + infrastructure)"
  ]'::jsonb,

  '{
    "value_vs_growth_rotation": {
      "russell_1000_value_day_return_pct": 3.61,
      "russell_1000_growth_day_return_pct": -1.41,
      "value_minus_growth_day_pct": 5.02,
      "notes": "Plus gros 1-day move value-growth spread depuis années 1990"
    },
    "stay_home_stocks_crash": {
      "zoom_day_pct": -17.4,
      "peloton_day_pct": -20.3,
      "netflix_day_pct": -8.6,
      "docusign_day_pct": -14.5,
      "moderna_day_pct": -7.0,
      "aapl_day_pct": -2.0,
      "notes": "Moderna paradoxalement baisse -7% (sa propre vaccin n''était pas dans les headlines ce jour — catch-up +10% semaine suivante)"
    },
    "reopening_stocks_rally": {
      "carnival_cruise_day_pct": 39.3,
      "norwegian_cruise_day_pct": 27.1,
      "boeing_day_pct": 13.7,
      "united_airlines_day_pct": 19.2,
      "american_airlines_day_pct": 15.2,
      "occidental_petro_day_pct": 22.6,
      "marriott_day_pct": 14.8,
      "notes": "Airlines, cruise lines, hotels, energy — sectors décimés par COVID up 10-40% en une journée"
    },
    "equity_small_caps_russell_2000": {
      "day_return_pct": 3.7,
      "6m_return_pct": 50.0,
      "notes": "Russell 2000 leader du reopening trade. Outperform S&P 500 sur 6 mois suivants."
    },
    "equity_banks_kbe": {
      "day_return_pct": 13.5,
      "6m_return_pct": 40.0,
      "notes": "Banks + steepening curve + reopening trade = triple tailwind"
    },
    "equity_energy_xle": {
      "day_return_pct": 14.2,
      "6m_return_pct": 60.0,
      "notes": "Energy rally massive 2020 nov - 2021 mai. Oil $35 → $65"
    },
    "govt_bonds_us_10y": {
      "day_yield_move_bps": 17,
      "pre_announcement_yield_pct": 0.79,
      "peak_6m_yield_pct": 1.75,
      "notes": "10y yield +96bps sur 6 mois — reflation trade, inflation anticipations montent"
    },
    "yield_curve_2s10s": {
      "pre_event_bps": 66,
      "peak_bps": 158,
      "peak_date": "2021-03-31",
      "notes": "Steepening massive. Reflation play dominant"
    },
    "commodities_oil_wti": {
      "pre_event_usd": 37.1,
      "peak_6m_usd": 66.0,
      "return_pct": 78.0,
      "notes": "Oil de $37 (9 nov) à $66 (mai 2021). Demand normalization pricée"
    },
    "commodities_copper": {
      "6m_return_pct": 37.0,
      "notes": "Copper leading indicator reflation — de $3.18 à $4.37/lb"
    },
    "fx_dxy": {
      "6m_move_pct": -5.0,
      "notes": "DXY weakens — reflation global = risk-on = dollar out of favor"
    },
    "bitcoin": {
      "pre_event_level_usd": 15500,
      "6m_level_usd": 58000,
      "peak_nov_2021_usd": 69000,
      "notes": "BTC rallye continue (pas value-growth story) — narrative inflation hedge + institutional adoption (MicroStrategy, Square, Tesla)"
    }
  }'::jsonb,

  '{
    "before": "Stay-home trade dominant. Tech mega-caps monopolisent gains S&P. Energy/financials/airlines laissés pour mort. Yields ancrés bas sans perspective de remontée. Inflation inattendue.",
    "after": "Reopening/reflation trade 6 mois. Value/cyclicals outperformance. Yields remontent structurellement. Premiers signes inflation apparaissent mi-2021 (ISM prices paid, housing, used cars). Narratif ''return to normal'' dominant jusqu''à été 2021 (puis Delta variant ramène doute)."
  }'::jsonb,

  'Rotation value-growth dure jusqu''en mai 2021 (peak cyclical). Puis tech rebondit été 2021 (Delta variant). Inflation devient le narrative Q4 2021. La rotation se révèle transitoire en termes de leadership absolu — Russell 2000 peak en mars 2021 et déclinera jusqu''au bear 2022. Mais le choc est permanent sur certains paires (CRM down, CRM ne retourne pas au high). Le pattern ''binary event + positioning unwind'' restera une leçon majeure.',

  '[
    "Les événements binaires MÉDICAUX sont pricés comme des options — le marché sous-price la probabilité forte d''outcome positif quand la technologie est nouvelle (mRNA)",
    "Positioning extrême = setup pour reversion violente quand catalyst intervient — ne pas confondre trend et positioning",
    "Les rotations sectorielles les plus extrêmes se font sur 1 journée, pas sur 1 mois — si tu rates le jour, tu rates 80% du move",
    "Small caps + cyclical + value = combo qui gagne en early recovery, underperforms en late cycle",
    "Steepening curve favorise banks + insurance, hurts utilities + REITs",
    "L''inflation narrative commence 6-12 mois avant qu''elle n''apparaisse dans les chiffres officiels — inflation anticipations dans breakevens TIPS",
    "Pair trades ''long A short B'' sont dangereux quand les deux legs décorrèlent — risk management via sizing",
    "Bitcoin ne suit PAS le pattern value-growth — son driver primary est adoption/liquidité, pas rotation sectorielle",
    "Vaccine rollout était MUCH faster que anticipated (9 mois Pfizer research to authorization) — tech revolution mRNA"
  ]'::jsonb,

  '[
    "Vaccine day était un événement unique (première fois mRNA vaccine approuvé) — pas de pattern direct applicable",
    "Positioning extrême 2020 ne se reproduit pas systematically — checker CFTC commitments et fund flows avant pricing in",
    "Reflation trade 2020-2021 a eu lieu depuis bases valuations basses — un reflation similaire aujourd''hui partirait de plus haut",
    "Le rate environment (Fed à 0%) favorisait duration long, durée shortening post-2022",
    "Biden stimulus + bipartisan deals : repeatable ? Environnement politique polarisé plus post-2024",
    "Structure tech vs value sectors a évolué : NVDA et AI hyperscalers redéfinissent ''tech'', value sector plus petit qu''en 2020"
  ]'::jsonb,

  array['medical_breakthrough','binary_event','value_growth_rotation','sector_rotation','reflation_trade','reopening_trade','positioning_unwind','vaccine_announcement','stay_home_reversal']::text[],

  'warning',
  'excellent',

  '[
    {"type":"press_release","title":"Pfizer and BioNTech Announce Vaccine Candidate Against COVID-19 Achieved Success","authors":"Pfizer","year":2020,"url":"pfizer.com"},
    {"type":"paper","title":"Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine","authors":"Polack et al","year":2020,"publisher":"NEJM"},
    {"type":"article","title":"The Biggest One-Day Rotation From Growth to Value in Decades","publisher":"Bloomberg","year":2020},
    {"type":"paper","title":"Value vs Growth: Historical Analysis","authors":"Fama-French","year":2021},
    {"type":"data","title":"Russell Index historical returns","publisher":"FTSE Russell"}
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
