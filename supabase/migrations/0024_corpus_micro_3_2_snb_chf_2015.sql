-- Migration 0024 — Corpus micro 3.2/5 : SNB EUR/CHF Floor Removal (15 jan 2015)
--
-- Le mouvement FX le plus violent de l''histoire moderne. La BNS abandonne
-- sans prévenir le plancher EUR/CHF 1.20. CHF s''apprécie de +30% en 15
-- minutes. De nombreux brokers FX font faillite. Leçon durable sur les
-- pegs : "ce qui ne peut continuer éternellement s''arrête".

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'snb_chf_floor_removal_2015',
  'Swiss National Bank abandons EUR/CHF 1.20 Floor',
  'currency_crisis',
  '2015-01-15',
  '2015-01-15',
  'Événement intraday (choc initial en 15 minutes), reprise partielle en quelques heures',
  'Le 15 janvier 2015 à 10h30 heure suisse, la BNS annonce sans prévenir l''abandon du plancher EUR/CHF à 1.20 qu''elle maintenait depuis septembre 2011. Le taux passe de 1.20 à 0.85 en 15 minutes (un mouvement intraday de -30%, sans précédent sur une devise majeure depuis Bretton Woods). Il close à ~1.00 en fin de journée. La BNS annonce simultanément un taux directeur à -0.75% (record négatif). Les causes : l''appréciation massive du USD et la perspective de QE imminent de la BCE (janvier 22, 2015) rendaient le plancher intenable — défendre aurait nécessité des interventions infinies en euros à des niveaux où la BNS aurait dû acheter des centaines de milliards de EUR. La BNS calcule que capituler maintenant est moins coûteux que plus tard. Conséquences immédiates : plusieurs brokers FX en faillite (Alpari UK, Global Brokers NZ), FXCM sauvé par un prêt d''urgence Leucadia de 300 M$, hedge funds fermés (Everest Capital perd 830 M$), clients retail ruinés (certains avec des pertes > dépôt à cause du leverage). Actions suisses -14% (pire journée depuis 1989). Horloger Swatch -16%, Nestlé -6%. Banques suisses (UBS, CS) -10-12%. CHF alimentés par les emprunteurs hypothécaires polonais/hongrois/croates (mortgages CHF-denominés) qui voient leur principal +20-30% en EUR du jour au lendemain.',

  '[
    "Plancher EUR/CHF 1.20 instauré 6 septembre 2011 (crise euro en pic) pour éviter déflation suisse",
    "BCE annonce QE imminent (prévu 22 jan 2015, 3 jours plus tard) → pression achat EUR/CHF intenable",
    "Bilan BNS déjà 85% PIB suisse en janv 2015 — une des plus grosses au monde relativement",
    "Intervention BNS aurait nécessité centaines de Md€ supplémentaires si plancher maintenu post-QE BCE",
    "Annonce surprise : 3 jours avant, BNS avait RÉAFFIRMÉ le plancher publiquement → trahison perçue par traders",
    "Stop losses massifs activés : algo HFT, CTA, retail tous positionnés short CHF",
    "Leverage retail FX 50:1 à 100:1 → wipe-out instantané de milliers de comptes",
    "Liquidity FX effondrée pendant 30 minutes — aucun prix affiché pendant plusieurs minutes sur EUR/CHF"
  ]'::jsonb,

  '[
    "USD en rally fort depuis mi-2014 (début cycle Fed hike expectations) → pression sur EUR et par proxy sur floor",
    "BCE Draghi speech 2 déc 2014 promettait ''all necessary unconventional measures''",
    "Bilan BNS dépassait 485 Md CHF (85% PIB) — gros positioning long EUR/short CHF",
    "Réserves BNS majoritairement EUR + quelques actions allemandes/françaises",
    "Inflation suisse déjà négative (-0.3% YoY) — appréciation CHF amplifie déflation",
    "Échecs précédents de défense de peg (HKD 1983 OK, THB 1997 KO, ARS 2001-2019 KO, etc.) documenté"
  ]'::jsonb,

  '{
    "fx_eurchf": {
      "pre_event_level": 1.2010,
      "intraday_low": 0.8517,
      "close_level": 0.9745,
      "peak_move_pct": -29.1,
      "close_move_pct": -18.8,
      "duration_of_extreme_minutes": 15,
      "notes": "De 1.20 à 0.85 en 15 min. Close à 0.97. Mouvement sans précédent sur une devise majeure."
    },
    "fx_usdchf": {
      "pre_event_level": 1.0200,
      "intraday_low": 0.7400,
      "move_pct": -27.5,
      "notes": "Flash crash similaire. USD/CHF de 1.02 à 0.74."
    },
    "equity_switzerland_smi": {
      "intraday_low_pct": -14.0,
      "close_pct": -8.7,
      "notes": "SMI -14% intraday, close -8.7%. Pire journée depuis 1989."
    },
    "equity_swiss_exporters": {
      "swatch_pct": -16.0,
      "nestle_pct": -6.0,
      "richemont_pct": -14.0,
      "notes": "Exporters horlogers, luxe les plus touchés (revenus EUR/USD, coûts CHF)"
    },
    "equity_swiss_banks": {
      "ubs_pct": -11.0,
      "credit_suisse_pct": -13.0,
      "notes": "Banques revenus IBD en dollars, coûts en CHF"
    },
    "swiss_rates_10y": {
      "pre_event_pct": 0.15,
      "post_event_pct": -0.20,
      "yield_move_bps": -35,
      "notes": "10y Swiss yield passe en NÉGATIF pour la première fois — record mondial à l''époque"
    },
    "gold_in_chf": {
      "peak_drawdown_pct": -17.0,
      "notes": "Or en CHF chute logiquement puisque CHF apprécie. Or en USD reste stable."
    },
    "fx_brokers_collapsed": {
      "alpari_uk": "Faillite (insolvent) — compte négatif clients",
      "global_brokers_nz": "Faillite",
      "fxcm": "Sauvé par prêt Leucadia 300 M$ (terms punitifs)",
      "excel_markets": "Faillite",
      "oanda": "Survived — absorbed losses",
      "notes": "Cascade de faillites dans l''écosystème FX retail — leverage + stop-loss killed"
    },
    "hedge_funds_impact": {
      "everest_capital": "Fermé (flagship fund, 830 M$ de pertes)",
      "comac_capital": "Fermé partiellement",
      "discovery_capital": "Importantes pertes",
      "notes": "Plusieurs macro funds wiped out sur positions short CHF"
    },
    "cee_mortgage_borrowers": {
      "impact": "Millions de mortgages CHF en Pologne, Hongrie, Croatie — principal +20-30% en monnaie locale overnight",
      "notes": "Crise sociale dans ces pays, lois conversion forcée promulguées ensuite"
    }
  }'::jsonb,

  '{
    "before": "Pegs FX défendables indéfiniment par banque centrale déterminée. Bilan BNS non-contraint. Leverage FX retail 100:1 accepté industrie.",
    "after": "Tous les pegs sont scrutés différemment (HKD, CNY onshore, DKK). Régulateurs limitent leverage retail FX (ESMA 2018 : 30:1 majors). Risk management FX revu. BNS reste en negative rates jusqu''en juin 2022."
  }'::jsonb,

  'Le choc initial 15 min, mais reprise progressive sur quelques heures (EUR/CHF remonte à 1.00). Le nouveau régime ''flottant'' avec taux négatif -0.75% tient jusqu''en juin 2022. BNS garde un bilan gigantesque (1200+ Md CHF en 2020). L''économie suisse absorbe l''appréciation grâce à sa structure (prix compétitifs, produits non-substituables, tourisme souffre). Le marché FX retail se régule progressivement.',

  '[
    "Les pegs peuvent se briser EN QUELQUES MINUTES quand la banque centrale abandonne — aucune sortie graduelle possible",
    "''What can''t go on forever, stops'' (Stein''s Law) — maxime validée empiriquement",
    "La surprise totale est l''intention politique : toute communication graduelle aurait permis un front-running massif",
    "Leverage FX retail 50:1 ou 100:1 est mathématiquement incompatible avec un tail event FX — ESMA a eu raison de capper à 30:1",
    "Hedge funds macro concentrent sur ''sure things'' qui se révèlent catastrophiques (pattern répété : LTCM 98, John Paulson 2012, Everest 2015)",
    "Un peg FX est une mise sur la ''credibility'' de la banque centrale — quand cette credibility vacille, unwind instantané",
    "Les stop-loss en FX sur devises peggées sont des pièges — se protéger par OPTIONS, pas des stops",
    "HKD peg à USD est le prochain candidat à surveiller — défendu depuis 1983, mais test en 2023 et 2024 sur tentatives déval",
    "Les mortgages en devise étrangère (FX-linked mortgages) sont des bombes à retardement structurelles"
  ]'::jsonb,

  '[
    "Depuis 2015, peu de banques centrales ont installé des pegs rigides — HKD et DKK principales exceptions",
    "Leverage FX retail limité par ESMA (2018) et autres régulateurs — événement de cette ampleur moins probable dans l''écosystème broker retail",
    "Mais les pegs restants (HKD 7.75-7.85, CNY onshore dans bande, GCC currencies peggées USD) restent vulnérables",
    "Pattern applicable à tout régime à bande : ''managed float'' Chine pourrait casser en cas de stress majeur",
    "Les stablecoins crypto (USDT, USDC) sont techniquement des pegs — cf. Terra UST collapse mai 2022"
  ]'::jsonb,

  array['fx_peg_break','currency_crisis','central_bank_surprise','leverage_wipeout','stop_loss_cascade','broker_failure','retail_trading_risk']::text[],

  'critical',
  'excellent',

  '[
    {"type":"press_release","title":"Swiss National Bank discontinues minimum exchange rate","publisher":"SNB","year":2015,"url":"snb.ch"},
    {"type":"article","title":"FXCM Got a $300 Million Rescue From Leucadia","publisher":"Wall Street Journal","year":2015},
    {"type":"paper","title":"The Swiss Franc Safe Haven Puzzle","authors":"Ranaldo, Soderlind","year":2010,"publisher":"Review of Finance"},
    {"type":"paper","title":"What Do We Know About The Swiss National Bank''s Decisions?","authors":"Auer, Tenhofen","year":2016,"publisher":"BIS"},
    {"type":"article","title":"The Black Swan of Currencies: Swiss Franc Day","publisher":"Financial Times","year":2015}
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
