-- Migration 0042 — Corpus micro 5.7 : 2026 Iran War + Oil Spike
--
-- Escalation directe US-Israel vs Iran début 2026. Brent +55% en 4 semaines
-- ($72 → $119). Strait of Hormuz concerns. G7 SPR release. Pattern choc
-- géopolitique commodity — référence pour future Middle East crises.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'iran_war_oil_spike_2026',
  '2026 US-Israel vs Iran Military Operation + Oil/Gold Spike',
  'geopolitical_conflict',
  '2026-02-28',
  '2026-04-30',
  'Phase aiguë ~2 mois depuis escalation militaire fin février à stabilisation avril',
  'Début 2026, escalation accelere autour Iran : tensions Israël-Hezbollah prolongées, attaques drones sur infrastructure maritime Golfe. Le 28 février 2026, US-Israel lancent opération militaire ciblée contre installations nucléaires iraniennes Natanz + Fordow. Iran riposte : attaques drones/missiles contre bases US Moyen-Orient + menaces fermeture Détroit d''Hormuz (20% global oil supply + 1/3 seaborne oil, including Kuwait, Qatar, partial UAE/Oman/Saudi/Iraq). Brent crude réagit violemment : de $72 (28 février) à $112 (27 mars) = +55% en 4 semaines. Peak $119.50 début mars. WTI +53% même période. Gold spike à $4400 (fly-to-safety + structural rally already, micro 5.6). VIX à 45. S&P 500 -7% initial puis stabilize. Action policy : G7 + IEA emergency call 3 mars — joint SPR release 120M barrels annoncé. Iran partial shutdown tentatives mais 20-30% volume gulf export degraded. Saudi Arabia announces capacity boost (+500k bpd available). Shale US responds (ramp takes 3-6 months). Inflation scare : CPI US Q1 2026 rebounds 3.8% (vs 2.9% projected). Fed pause cuts. USD gains 3% initially. Market stabilization : Iran nuclear program significantly degraded, but not destroyed. Limited regime change — Khamenei survives, government intact. Ceasefire negotiated April via Qatar + Oman mediators. Oil retreats $90 end avril. Long-term implications : (1) nuclear non-proliferation precedent (first strike on nuclear infrastructure since Iraq 1981 Osirak) ; (2) Saudi-Iran relations reassessment ; (3) Shale US $70 floor price validated ; (4) Europe energy security reviewed again (already post-Ukraine 2022) ; (5) Defense stocks structural bid ; (6) Commodities supercycle amplified. Pattern classique ''guerre Moyen-Orient → oil spike → inflation → Fed delayed cuts → recession fears'' reinforces 1973, 1990 precedents but with supply modernity (shale US).',

  '[
    "28 février 2026 : US-Israel military operation against Iranian nuclear sites Natanz + Fordow",
    "Iran counter-attacks : drones + missiles vs US bases région (Bahrain, Qatar, Iraq)",
    "Strait of Hormuz transit disruption : ~30% oil flows affected March 2026",
    "Brent crude : $72 (28 fév) → $112.57 (27 mars) = +55.3% en 4 semaines",
    "Brent peak $119.50 intraday early March 2026",
    "WTI crude similar +53% move",
    "Gold reaches $4400/oz (combined with structural rally, micro 5.6)",
    "G7 + IEA emergency SPR release 120M barrels announced 3 mars",
    "Saudi Arabia announces ''+500k bpd available capacity''",
    "Qatar + Oman mediation for ceasefire April 2026",
    "Iran nuclear program degraded ~70% (intelligence estimates)",
    "Ceasefire April 2026 — limited US/Israel success, no regime change",
    "Oil retreats $90 end avril 2026 on diplomatic resolution",
    "VIX peak 45 (intraday 52)",
    "S&P 500 -7% peak drawdown, recovery 6 weeks"
  ]'::jsonb,

  '[
    "October 7, 2023 Hamas attack Israel → prolonged Gaza war + regional spillover",
    "Israel-Hezbollah conflict 2023-2025 ongoing south Lebanon",
    "Iran-Israel direct exchange April 2024 (Israel strike Damascus consulate, Iran missile/drone attack, Israel strike Isfahan)",
    "Houthi Red Sea attacks 2023-2025 : disrupted shipping, 50%+ Red Sea traffic rerouted",
    "Iranian nuclear program progression — 90%+ enriched uranium reserves expanding 2024-2025",
    "US military buildup region 2025 — CVNs + B-2 deployed",
    "Saudi-Iran détente Beijing March 2023 — fragile",
    "Trump administration 2025+ : hawkish Iran stance, Pompeo appointed",
    "Oil prices range-bound $70-85 2025 — relatively stable despite tensions",
    "Strategic Petroleum Reserve (SPR) US refilling 2024-2025 post Biden draw",
    "Saudi spare capacity estimate 2-3 mbpd available"
  ]'::jsonb,

  '{
    "commodities_brent_crude": {
      "pre_event_usd": 72.48,
      "peak_usd": 119.50,
      "peak_date": "2026-03-08",
      "4_week_return_pct": 55.3,
      "end_april_usd": 90,
      "notes": "Brent best monthly gain since May 2020. +55% in 4 weeks before partial retracement."
    },
    "commodities_wti_crude": {
      "pre_event_usd": 68,
      "peak_usd": 112,
      "return_pct": 53,
      "notes": "WTI similar magnitude — US shale strategic position strengthens"
    },
    "geopolitical_risk_premium_per_barrel": {
      "calculated_usd": 14,
      "notes": "~$14/barrel premium ((Goldman Sachs estimate full 4-week Hormuz halt) embedded"
    },
    "commodities_natural_gas_eu_ttf": {
      "pre_event_eur_mwh": 28,
      "peak_eur_mwh": 55,
      "move_pct": 96,
      "notes": "Not as extreme as 2022 — EU energy diversification post-Ukraine reduced vulnerability"
    },
    "commodities_gold": {
      "pre_event_usd": 3800,
      "peak_usd": 4400,
      "return_pct": 16,
      "notes": "Already in structural rally (micro 5.6), geopolitical add +16% additional"
    },
    "equity_us_sp500": {
      "peak_drawdown_pct": -7,
      "trough_date": "2026-03-18",
      "recovery_days": 42,
      "notes": "Markets digest geopolitical shock + inflation rebound. Recovery once ceasefire trajectory clear"
    },
    "equity_defense_sector": {
      "lockheed_return_pct": 25,
      "rtx_return_pct": 18,
      "general_dynamics_return_pct": 20,
      "palantir_return_pct": 35,
      "notes": "Defense sector outperform structurally. Palantir AI defense plays tailwind"
    },
    "equity_energy_sector_xle": {
      "return_pct": 22,
      "notes": "Energy stocks rally on oil spike. Exxon, Chevron benefit. Shale producers (Pioneer, EOG) outperform"
    },
    "equity_airlines_cruiselines": {
      "daily_drop_range_pct": "-8 to -12",
      "notes": "Fuel exposure + travel fear → airlines (DAL, UAL, AAL) and cruise (CCL, RCL) sell-off"
    },
    "fx_dxy": {
      "pre_event_level": 98,
      "peak_level": 101,
      "move_pct": 3,
      "notes": "Modest USD rally — partial safe haven, but countered by oil rally narrative"
    },
    "fx_safe_haven_chf_jpy": {
      "chf_appreciation_pct": 4,
      "jpy_appreciation_pct": 3,
      "notes": "Classic safe haven FX flows — moderate moves"
    },
    "govt_bonds_us_10y": {
      "pre_event_yield_pct": 4.0,
      "intraday_low_yield_pct": 3.6,
      "inflation_driven_peak_pct": 4.35,
      "notes": "Dual dynamic — initial flight to safety (yields down), then inflation fears (yields up on oil)"
    },
    "bitcoin": {
      "pre_event_level_usd": 115000,
      "trough_usd": 95000,
      "recovery_to_usd": 120000,
      "drawdown_pct": -17,
      "notes": "BTC -17% initial correction, recovers quickly. ''Digital gold'' narrative supported."
    },
    "gulf_states_equity_impact": {
      "saudi_tadawul_pct": -5,
      "adx_abu_dhabi_pct": -7,
      "qse_qatar_pct": -4,
      "notes": "Regional markets bien performers relatively — oil windfall partially offsets geopolitical risk"
    }
  }'::jsonb,

  '{
    "before": "Iran sanctions regime ineffective (exports via dark fleet), nuclear program advancing (90%+ uranium stockpile), Saudi-Iran détente fragile, shale US price-taker, Middle East perceived as manageable rick.",
    "after": "Nuclear non-proliferation via military action precedent (first since 1981 Osirak). Iran nuclear program degraded mais recoverable. Regional power dynamics : Saudi Arabia + UAE consolidate US alignment. Russia-China support for Iran exposed limits. Shale US strategic swing producer validated. Europe energy diversification reviewed. Defense spending structurally higher NATO + Gulf. Oil structural floor $70 revealed. Inflation scare limits Fed dovish 2026."
  }'::jsonb,

  'Ceasefire April 2026 via Qatar/Oman mediation. Iran partial compliance IAEA inspections. US-Iran diplomatic dialogue limited. Oil $85-95 range through H2 2026. No regime change Iran. Nuclear program partially restorable (3-5 year timeline with new covert facilities). Gulf states increase defense spending ($100+ Md additional 2026-2030). Europe accelerates energy transition further. Russia-China strategic partnership with Iran reinforced. Long-term: Iran-Israel conflict not resolved, potential re-escalation 2027+.',

  '[
    "Middle East conflicts can spike Brent 50%+ in 4 weeks — geopolitical premium elastic",
    "Strait of Hormuz = tier-1 chokepoint (20-30% global oil) — partial disruption = systemic",
    "Shale US = strategic swing producer — responds in 3-6 months, caps oil at $120-ish structurally",
    "Saudi Arabia spare capacity (2-3 mbpd) = critical stabilizer — activates in crisis",
    "Gold + defense stocks = reliable beneficiaries geopolitical shocks",
    "Airlines + cruiselines = reliable losers (fuel + travel fear double hit)",
    "Oil inflation passes through to core inflation with 3-6 month lag — Fed policy delayed",
    "Bitcoin partial safe haven role — -17% initial but quick recovery, better than equities",
    "USD safe haven moderate in oil-driven crises (oil = USD-denominated trade, complicates flow)",
    "Ceasefire timing typically 4-8 weeks after major escalation — pattern Qatar/Oman mediation",
    "Nuclear non-proliferation military action rare but precedent-setting (Osirak 1981, Syria 2007, Iran 2026)",
    "Regional markets mixed : oil exporters (Saudi, UAE) relatively better than neutral (Egypt, Turkey)"
  ]'::jsonb,

  '[
    "Each Middle East conflict unique — Iran 2026 ≠ Iraq 1990 ≠ Iraq 2003 ≠ Syria 2013",
    "Shale US buffer = modern phenomenon (post-2010) — pre-2010 analogies less useful",
    "Saudi-Iran dynamics changed (post-2023 Beijing deal) — different from pre-2023 proxy wars",
    "EU energy dependency post-Ukraine 2022 much lower than 2014 — supply shock less painful",
    "Iran''s sanctions regime sophisticated — partial degradation less effective than expected",
    "Trump admin 2025+ may pursue different doctrine than Bush/Obama/Biden eras"
  ]'::jsonb,

  array['geopolitical_conflict','middle_east','oil_spike','strait_of_hormuz','nuclear_non_proliferation','iran','israel','shale_swing_producer','saudi_spare_capacity','safe_haven_rally','defense_sector_rally','spr_release']::text[],

  'critical',
  'excellent',

  '[
    {"type":"paper","title":"How Will the Iran Conflict Impact Oil Prices","publisher":"Goldman Sachs Research","year":2026},
    {"type":"article","title":"Brent Crude Best Monthly Gain Since 2020","publisher":"CNBC","year":2026},
    {"type":"report","title":"Strait of Hormuz Impact Analysis","publisher":"US EIA","year":2026},
    {"type":"article","title":"Economic Impact of 2026 Iran War","publisher":"Wikipedia","year":2026},
    {"type":"report","title":"Iran-Israel Escalation","publisher":"Oxford Economics","year":2026},
    {"type":"paper","title":"The Global Oil Market in a Middle East Conflict","publisher":"IEA","year":2026}
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
