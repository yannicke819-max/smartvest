-- Migration 0025 — Corpus micro 3.3/5 : Oil Crash 2014-2016
--
-- Effondrement du prix du pétrole brut de 77% en 18 mois sur un mix
-- supply shock (US shale boom) + OPEC price war + demand slowdown (Chine)
-- + USD strength. Modèle de commodity bust cycle. Effets durables sur
-- devises pétro-exportatrices, credit HY US (shale firms), géopolitique
-- Russie/Arabie/Venezuela.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'oil_crash_2014_2016',
  'Oil Price Crash 2014-2016',
  'commodity_shock',
  '2014-06-20',
  '2016-02-11',
  '20 mois du pic Brent 115$ (juin 2014) au creux 27$ (fév 2016)',
  'Le 20 juin 2014, le Brent touche 115$ sur tensions Irak (ISIS avance sur Bagdad). À partir de là, chute continue sur 20 mois jusqu''au creux de 27$ le 11 février 2016 (-77%). Les drivers sont multiples et se cumulent : (1) le US shale oil boom triple la production US de 5 mb/j (2008) à 9.7 mb/j (2015) — les US deviennent swing producer ; (2) OPEC sous leadership saoudien DÉCIDE le 27 novembre 2014 (réunion OPEC Vienne) de NE PAS couper la production — stratégie de ''price war'' pour casser le shale US ; (3) demande chinoise ralentit en 2014-2015 (Chine deval août 2015) ; (4) USD en rally fort (commodities priced in USD) ; (5) Iran revient sur le marché après accord nucléaire (juillet 2015) ; (6) positioning spéculatif long démesuré (open interest record). Les conséquences sont massives : RUB -50% (crise 2014-2015), CAD -25%, NOK -25%. Secteur énergie S&P 500 -50%. HY crédit spreads +600bps (energy sector représente 17% du HY index). Faillites shale US : >140 entreprises 2015-2017 (Linn Energy, SandRidge, Ultra Petroleum). Venezuela en crise (défaut 2017). Arabie puise dans reserves FX (de 740 Md$ en 2014 à 480 Md$ en 2017).',

  '[
    "US shale oil production : 5 mb/j (2008) → 9.7 mb/j (avril 2015) → 8.5 mb/j (sept 2016 trough)",
    "OPEC Vienne 27 nov 2014 : REFUS de cut, maintien ceiling 30 mb/j malgré surplus",
    "Stratégie saoudienne : casser shale US via prix bas + maintenir part de marché global",
    "China demand slowdown : croissance PIB 10.6% (2010) → 6.9% (2015) → 6.7% (2016)",
    "USD rally : DXY 80 (mi-2014) → 103 (fin 2016), compresse commodities globalement",
    "Iran nuclear deal (JCPOA) juillet 2015 → levée sanctions, +1 mb/j en 2016",
    "Libye production volatile : 1.5 mb/j → 0.2 mb/j → 0.9 mb/j sur la période",
    "Positioning spéculatif historique : net long WTI futures 550k contracts mi-2014",
    "Storage constraints : Cushing OK proche saturation mi-2016 — contango extrême"
  ]'::jsonb,

  '[
    "Boom US shale depuis 2010 (Bakken, Eagle Ford, Permian) — productivité du forage horizontal + fracking",
    "Reserves d''actifs énergétiques massifs : ExxonMobil, Chevron, Shell valorisés sur $100 oil long-term",
    "Dette HY énergie US massive : 275 Md$ encours 2014, shale firms leveraged",
    "Fracking breakeven autour de $60-70/bbl en 2014 (vs $30 aujourd''hui grâce aux gains de productivité)",
    "Signals précoces : Brent topped at $115 June 2014 malgré ISIS advance — capacité US à compenser supply disruption",
    "Contango WTI-Brent spread $15+/bbl — signal du surplus structurel US"
  ]'::jsonb,

  '{
    "commodities_brent_crude": {
      "peak_level_usd": 115.06,
      "peak_date": "2014-06-20",
      "trough_level_usd": 27.88,
      "trough_date": "2016-01-20",
      "peak_drawdown_pct": -75.8,
      "duration_to_trough_days": 579,
      "duration_to_recovery_usd80_days": 1850,
      "notes": "Pattern classique bust: chute rapide (-50% en 6 mois), stabilisation $40-55, trough final sur capitulation fév 2016"
    },
    "commodities_wti_crude": {
      "peak_level_usd": 107.95,
      "trough_level_usd": 26.21,
      "peak_drawdown_pct": -75.7,
      "notes": "WTI suit Brent avec spread négatif élargi (surplus local Cushing)"
    },
    "energy_equities_xle": {
      "peak_drawdown_pct": -50.0,
      "peak_drawdown_date": "2016-01-20",
      "notes": "XLE (Energy ETF) $101 (juin 2014) → $49 (fév 2016). 50% drawdown. Lag vs oil : equities bottom 1 mois après oil."
    },
    "fx_rub_russia": {
      "peak_depreciation_pct": -58.0,
      "pre_event_level": 33.0,
      "trough_level": 85.0,
      "trough_date": "2016-01-21",
      "notes": "RUB/USD de 33 (juin 2014) à 85 (jan 2016). Amplifié par sanctions post-Crimée + crise bancaire russe. CBR hike 650bps en déc 2014 (taux 17%) pour stabiliser."
    },
    "fx_cad_canada": {
      "peak_depreciation_pct": -24.0,
      "notes": "USD/CAD de 1.06 (juin 2014) à 1.46 (jan 2016)"
    },
    "fx_nok_norway": {
      "peak_depreciation_pct": -27.0,
      "notes": "USD/NOK de 6.05 à 8.94. Norges Bank cuts rates"
    },
    "credit_hy_energy": {
      "spread_peak_bps": 1650,
      "pre_event_bps": 350,
      "spread_widening_bps": 1300,
      "notes": "HY Energy OAS 350bps → 1650bps. Vague de défauts 2015-2017, 140+ faillites shale"
    },
    "credit_hy_broad": {
      "spread_peak_bps": 890,
      "pre_event_bps": 335,
      "spread_widening_bps": 555,
      "notes": "HY broad infecté par contagion energy (17% du HY index)"
    },
    "equity_em_broad": {
      "peak_drawdown_pct": -34.0,
      "notes": "MSCI EM en bear 2014-2016 (commodities + China slowdown + stronger USD)"
    },
    "saudi_fx_reserves": {
      "peak_level_usd_bn": 740,
      "trough_level_usd_bn": 480,
      "drawdown_pct": -35.0,
      "notes": "Saudi FX reserves drain de 260 Md$ en 2 ans — stress fiscal Royaume"
    },
    "venezuela_default": {
      "timeline": "Default officiel novembre 2017 — oil était 50% des revenus gouvernementaux",
      "notes": "Hyperinflation subséquente, crise humanitaire majeure"
    }
  }'::jsonb,

  '{
    "before": "OPEC perçu comme swing producer ultime. Prix ancré $100+. Shale US marginal. Pétro-États fiscalement confortables.",
    "after": "US devient swing producer de facto. OPEC+ (OPEC + Russia, 2016+) pour coordination renforcée. Oil structurellement à $50-90 range. Break-even shale descendu à $30-35. Energy transition accelerates (mais timid). Weaker petro-states forcés à diversifier (Saudi Vision 2030)."
  }'::jsonb,

  'Accord OPEC+ Vienne le 30 novembre 2016 : cut de 1.2 mb/j (premier cut depuis 2008). Russie s''engage pour 0.3 mb/j supplementaire. Brent rallye à $55 fin 2016. Stabilisation $50-70 sur 2017-2019. Le cycle ne se refera pas à l''identique : OPEC+ formalisé, shale discipline. Cycle 2020 COVID sera un autre pattern (demand-shock, pas supply-shock).',

  '[
    "Commodity busts suivent pattern 3 phases : supply shock → speculative unwind → capitulation finale (Brent 115→60→40→27)",
    "US shale a redéfini la structure du marché pétrolier — swing producer mécanisme",
    "Currency des petro-states (RUB, CAD, NOK, COP) corrélées fortement au crude — proxy trade commun",
    "HY énergie est le canari dans la mine du HY global (17% du HY = énergie) — spreads énergie leaders",
    "Saudi strategy ''price war'' a partiellement échoué : shale est revenu dès que prix > $45 grâce à gains productivité",
    "Saudi FX reserves = levier critique pour défendre peg SAR/USD — surveiller drain en crisis",
    "Positioning spéculatif net long extrême = signal contrarian — mais timing difficile",
    "Contango extrême (curve storage-constrained) = bottom signal mais peut durer des mois",
    "Oil sub-$30 crée stress systémique (défauts énergie cascade → HY broad → risk-off général)",
    "Demand Chine est déterminant : 15% de la demande globale, marginale sur la balance supply-demand"
  ]'::jsonb,

  '[
    "Régime post-shale permanent : supply US plus réactive, cycles plus courts",
    "OPEC+ coordination rend la stratégie ''let the price fall'' moins probable",
    "Energy transition (EVs, renewables) en cours — demand oil pic attendu 2028-2032 selon IEA",
    "Géopolitique Moyen-Orient (Iran 2024-2025) crée des primes de risque volatiles mais pas de bust long",
    "Crude futures market a évolué — financialisation poussée, position speculative plus encadrée",
    "Pas applicable à crash oil COVID (avril 2020, WTI NÉGATIF -37$) qui était demand shock pur + storage physique"
  ]'::jsonb,

  array['commodity_bust','oil_cycle','supply_shock','petrocurrency_crisis','em_commodity_correlation','shale_revolution','opec_dynamics']::text[],

  'warning',
  'excellent',

  '[
    {"type":"report","title":"World Oil Outlook 2015","publisher":"OPEC","year":2015},
    {"type":"report","title":"Oil Market Report","publisher":"International Energy Agency","year":2015},
    {"type":"paper","title":"The Great Crude Oil Price Cycle","authors":"Baumeister, Kilian","year":2016,"publisher":"Journal of Economic Perspectives"},
    {"type":"book","title":"The Prize: The Epic Quest for Oil, Money & Power","authors":"Daniel Yergin","year":2008},
    {"type":"data","title":"EIA Weekly Petroleum Status Report","publisher":"US EIA"},
    {"type":"paper","title":"The U.S. Shale Oil Revolution and Its Market Impact","authors":"Mohn","year":2017}
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
