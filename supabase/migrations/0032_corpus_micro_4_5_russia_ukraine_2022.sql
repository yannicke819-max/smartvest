-- Migration 0032 — Corpus micro 4.5/6 : Russia invades Ukraine (24 fév 2022)
--
-- Premier conflit armé majeur en Europe depuis WWII. Commodities spike,
-- sanctions financières sans précédent (SWIFT exclusion, Russian CB
-- reserves freeze 300 Md$). Reshape de la géopolitique énergétique EU.

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'russia_ukraine_invasion_2022',
  'Russia Full-Scale Invasion of Ukraine + Sanctions Regime',
  'geopolitical_conflict',
  '2022-02-24',
  '2022-07-31',
  'Phase aiguë ~5 mois, guerre toujours en cours (conflit prolongé)',
  'Le 24 février 2022 à 04h00 heure Moscou, Vladimir Poutine annonce ''opération militaire spéciale'' en Ukraine. Forces russes envahissent par nord (Biélorussie), est (Donbass) et sud (Crimée). Kiev menacé dans les premières 48h. La réaction marchés et Occident est massive : (1) Sanctions financières sans précédent : SWIFT exclusion banques russes majeures (26 février), gel 300 Md$ de réserves Banque Centrale de Russie (environ 50% du total), sortie forcée des entreprises occidentales (McDonald''s, BP, Shell, Siemens, 1000+ companies), embargo progressive pétrole/gaz russes. (2) Commodities spike : Brent touche 139$ le 7 mars (depuis 92$), gaz naturel TTF EU +1000% pic septembre 2022, blé Chicago +50% en 3 semaines (Russie + Ukraine = 30% export blé mondial), palladium +90% (Russie = 40% global). (3) Russian markets fermés 25 jours, réouverture contrôlée ; rouble -50% initialement puis -15% (rescue CBR + capital controls) ; VTB, Sberbank delisted London. (4) Europe énergie crisis : Nord Stream 1 réduit puis sabotage 26 septembre 2022 (attributs US/UKR/RU selon versions), gaz naturel TTF 345 EUR/MWh peak. Allemagne fait face à menace de désindustrialisation BASF, acier. (5) Inflation amplifiée globalement — contribue au Fed tightening urgent (voir micro 4.4). (6) Refuge flows : or +8%, USD +4%, CHF +3%. (7) Russie exclue système financier occidental — re-couple Chine-Russie, accélération de-dollarization (paiements yuan Russia-China).',

  '[
    "24 février 2022 04h00 Moscou : ''opération militaire spéciale'' annoncée par Putin",
    "SWIFT exclusion 7 banques russes 26 février (Sberbank + VTB gardées initialement puis added)",
    "Russian CB reserves freeze : 300 Md$ gelés (50% des 630 Md$ totaux) par G7 + EU + Suisse + Japon",
    "Capital controls Russie : interdiction vente actifs russes par étrangers + conversion forced RUB",
    "Corporate exodus : 1000+ companies western se retirent Russie (Yale CELI database)",
    "Embargo charbon russe EU août 2022, crude pétrole décembre 2022 avec G7 price cap 60$",
    "Brent peak 139.13$ 7 mars 2022",
    "TTF EU gaz naturel peak 345 EUR/MWh 26 août 2022 (vs 20 EUR/MWh normal pre-war)",
    "Nord Stream 1 sabotage 26 septembre 2022 — gas supply EU-RU formellement terminé",
    "USDRUB peak 137 le 7 mars (rouble -50%), puis 52 en juin (over-rally post capital controls) puis stabilize 90-100",
    "Ukrainian grain corridor initiative (juillet 2022, Turkey + UN) stabilise prix food commodities"
  ]'::jsonb,

  '[
    "Russia buildup militaire à la frontière ukrainienne depuis octobre 2021 — estimated 150k troops",
    "Biden warning décembre 2021 ''invasion imminente'' — marché sceptique",
    "OTAN refuse d''exclure adhésion future Ukraine → casus belli Russia",
    "Nord Stream 2 completion 2021, allumage reporté → allemand Scholz gèle projet 22 février 2022",
    "Commodity positioning long depuis automne 2021 (reopening trade post-COVID)",
    "Ruble weakening depuis novembre 2021 sur escalation threats",
    "Russian stocks (MOEX) déjà -20% depuis oct 2021",
    "2014 Crimean annexation précédent : pattern sanctions limitées → Russia avait pricé low cost de nouvelle invasion",
    "Nord Stream 1 gas flow inchangé jusqu''à mai 2022 — EU sceptique sur weaponisation énergétique"
  ]'::jsonb,

  '{
    "commodities_brent_crude": {
      "pre_event_level_usd": 92,
      "peak_level_usd": 139.13,
      "peak_date": "2022-03-07",
      "peak_return_pct": 51.2,
      "end_2022_level_usd": 85,
      "notes": "Spike +51% en 2 semaines. Retour sous $100 mi-2022 après SPR release + demande Chine lockdowns."
    },
    "commodities_natural_gas_ttf_eu": {
      "pre_war_eur_mwh": 75,
      "peak_eur_mwh": 345.0,
      "peak_date": "2022-08-26",
      "return_pct": 360,
      "notes": "Gaz naturel EU explosion. Crise industrielle Allemagne. Peak 15x normal pre-war."
    },
    "commodities_wheat": {
      "pre_event_usd_bushel": 7.8,
      "peak_usd_bushel": 12.94,
      "peak_date": "2022-03-08",
      "return_pct": 66,
      "notes": "Russia + Ukraine = 30% global wheat exports. Peak sur disruption exports Black Sea"
    },
    "commodities_palladium": {
      "pre_event_usd_oz": 2300,
      "peak_usd_oz": 3440,
      "peak_date": "2022-03-07",
      "return_pct": 50,
      "notes": "Russia = 40% global palladium. Critique catalyseurs auto. Substitution partielle platinum"
    },
    "commodities_nickel": {
      "event": "LME Nickel short squeeze March 8, 2022",
      "peak_intraday_usd": 100000,
      "pre_event_usd": 24000,
      "notes": "Nickel +250% en 2 jours. LME force suspension + cancellation trades (Tsingshan short position). Scandale LME."
    },
    "commodities_gold": {
      "pre_event_level_usd": 1900,
      "peak_level_usd": 2070,
      "peak_date": "2022-03-08",
      "return_pct": 9,
      "notes": "Safe haven classique. Peak $2070 same day que Brent peak"
    },
    "fx_usdrub": {
      "pre_event_level": 75,
      "peak_crash_level": 137,
      "peak_date": "2022-03-07",
      "over_rally_level": 52,
      "over_rally_date": "2022-06-27",
      "stabilized_level": 100,
      "notes": "RUB crash -50% initial, then over-rally post capital controls + mandatory foreign reserve conversion. Stabilized 90-100 jusqu''en 2024."
    },
    "equity_russia_moex": {
      "closed_days": 25,
      "pre_closure_drawdown_pct": -50,
      "reopening_date": "2022-03-24",
      "notes": "Russian stock market fermé 24 fév - 24 mars. Rouverture contrôlée (limited short selling, foreign selling banned)"
    },
    "equity_european_broad": {
      "peak_drawdown_pct": -20,
      "peak_drawdown_date": "2022-03-07",
      "notes": "Euro Stoxx 50 -20% de mi-fév à début mars. Recovery partielle mais weakness structurelle dur 2022"
    },
    "equity_european_banks": {
      "peak_drawdown_pct": -30,
      "notes": "EU banks + duration + russie exposures → -30% sur le choc. SocGen, UniCredit, RBI more exposed"
    },
    "equity_defense": {
      "lockheed_2022_return_pct": 40,
      "raytheon_2022_return_pct": 20,
      "northrop_2022_return_pct": 41,
      "notes": "Defense sector benefits — Germany annonce Zeitenwende 100Md€ militaire, NATO 2% GDP commitments"
    },
    "commodities_exports_russia_stopped": {
      "oil": "EU embargo December 2022 + G7 price cap 60$",
      "gas": "EU diversification LNG US + qatar progressive",
      "coal": "EU embargo August 2022",
      "fertilizers": "Disruption avec exemptions food security",
      "metals": "London Metal Exchange bans Russian metals (2023)"
    }
  }'::jsonb,

  '{
    "before": "Globalisation énergétique : EU dependent gaz russe (40% import 2021), Russia integrated dans système financier global, USD reserve hegemony incontestée, sanctions financières considérées comme limitées.",
    "after": "EU diversification énergétique accélérée : LNG US (Cheniere, Venture Global), Qatar long-term contracts. Weaponisation du USD/SWIFT confirmée — accélère de-dollarization BRICS. Nord Stream détruit. Nouvelle Cold War économique Russia-West. Chine observe sanctions playbook (implications Taiwan). Global reserve managers augmentent gold, reduce USD. Europe accélère transition énergétique + rearmament."
  }'::jsonb,

  'Guerre toujours en cours fin 2025 avec conflit prolongé (drone warfare, attrition). Commodities stabilisés 2023-2024 après peak 2022. Gaz EU revenu sous 50 EUR/MWh. Sanctions continuent évoluer (price cap oil, crypto bans, tech transfer). Ukraine reçoit >150 Md$ aide militaire + financière cumulée (US, EU). Peace negotiations pas abouti. Economic effect primaire : inflation spike contribué à Fed hiking cycle (micro 4.4). Structural shift EU vers rearmament + decoupling énergétique.',

  '[
    "Géopolitique peut multiplier les commodities x2-3 en quelques jours si supply disruption crédible",
    "Corrélation sanctions financières × weight dans économie globale = impact amplifié — Russia pas à l''abri malgré réserves FX 630Md$",
    "Reserve FX d''une banque centrale PEUVENT être gelés — ''sanctions risk'' devient factor investissement pour réserves EM/BRICS",
    "Nord Stream sabotage montre que infrastructure énergétique est nouveau vecteur conflit — risk insurance upped durablement",
    "Safe-haven rally classic fonctionne MAIS brief — gold peaked 8 mars et baisse ensuite malgré conflit prolongé",
    "Commodities producers (XOM, CVX, BHP, GLEN) outperform pendant choc — pas tech, pas duration",
    "Defense stocks sont structural winners d''un régime géopolitique plus hostile — pas juste trade court terme",
    "Russia''s economic resilience via capital controls + energy revenues surprise — isolement financier pas = effondrement",
    "Small-cap commodities producers outperform majors dans commodity spike",
    "EU-specific exposure (DAX, CAC, utilities, industrials) sous-performe US durablement",
    "Timing d''entrée sur commodities spike : peak généralement 2-4 semaines après début conflit (panic peak)"
  ]'::jsonb,

  '[
    "Conflit prolongé = normalisation commodities — peak prices transitoires",
    "Chaque conflit a sa signature commodity : Russia-Ukraine = gas + grains, Iran = oil (cf 2026), Taiwan = semi-conducteurs",
    "Sanctions playbook maintenant connu — Russia s''est adapté, prochaine cible s''adaptera aussi",
    "De-dollarization structurelle accélère mais lent — USD hegemony persists court/moyen terme",
    "Europe transition énergétique 2022-2025 réduit vulnérabilité future à supply shocks",
    "Sanctions secondaires (sur pays tiers qui tradent avec Russie) effectives mais complexes"
  ]'::jsonb,

  array['geopolitical_conflict','commodity_shock','energy_crisis','sanctions_regime','fx_peg_break','safe_haven_rally','defense_sector_rally','europe_energy_crisis','deglobalization','reserve_currency_weaponization']::text[],

  'critical',
  'excellent',

  '[
    {"type":"report","title":"War in Ukraine: Economic and Market Implications","publisher":"IMF WEO","year":2022},
    {"type":"paper","title":"The Impact of Sanctions on the Russian Economy","authors":"Itskhoki, Mukhin","year":2022},
    {"type":"database","title":"Yale CELI - Corporate Responses to Russia","publisher":"Yale School of Management","year":2022},
    {"type":"paper","title":"Weaponizing the Dollar","publisher":"Council on Foreign Relations","year":2023},
    {"type":"report","title":"European Energy Crisis","publisher":"IEA","year":2022},
    {"type":"book","title":"Putin''s War: From Chechnya to Ukraine","authors":"Mikhail Zygar","year":2023}
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
