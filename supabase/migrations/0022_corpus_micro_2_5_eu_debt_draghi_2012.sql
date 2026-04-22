-- Migration 0022 — Corpus micro 2.5/5 : European Sovereign Debt Crisis
--                                        + Draghi "Whatever It Takes"
--
-- Crise de dette souveraine majeure de la décennie, relais direct de la
-- crise bancaire 2008. Teste la viabilité même de l''euro. Résolue (sans
-- être fermée) par l''intervention de Mario Draghi le 26 juillet 2012.
--
-- Valeur pédagogique unique :
--   - Pattern d''une crise de financement souverain (jumeaux sovereign
--     banking doom loop)
--   - Comment UN DISCOURS de banquier central peut devenir un catalyst
--     historique (3 mots : ''whatever it takes'')
--   - Importance du statut de reserve currency dans la résolution des
--     crises (comparer USD en 2008 vs EUR en 2012)

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  'eu_sovereign_debt_crisis_draghi_2010_2012',
  'European Sovereign Debt Crisis + Draghi "Whatever It Takes"',
  'sovereign_crisis',
  '2010-04-23',
  '2012-09-06',
  '~28 mois de la demande de bailout grec (avril 2010) à l''annonce OMT par la BCE (sept 2012)',
  'La Grèce demande un bailout officiel le 23 avril 2010 (rendement 10y à 9%, dette révisée 15.4% du PIB 2009 vs 6% annoncé initialement). Contagion à Irlande (novembre 2010, bailout 85 Md€), Portugal (avril 2011, 78 Md€), Espagne (yields 10y atteignent 7.62% le 24 juillet 2012), Italie (6.61% même période), Chypre (mars 2013). La "doom loop" sovereign-banking : banques EU détiennent massivement leur dette souveraine domestique (regulatory zero risk-weight), la baisse du souverain détruit leur capital, forçant désendettement qui aggrave la récession qui aggrave le souverain... La BCE de Trichet hésite, hike en juillet 2011 (crise) puis cut rapidement. La Grèce restructure sa dette (PSI, 53.5% haircut) en mars 2012 (250 Md€ effacés). Le 26 juillet 2012, à la Global Investment Conference de Londres, Mario Draghi prononce la phrase qui changera tout : "Within our mandate, the ECB is ready to do whatever it takes to preserve the euro. And believe me, it will be enough." Trois mots (''whatever it takes'') qui vont comprimer instantanément les yields périphériques. Le 6 septembre 2012, la BCE annonce le programme OMT (Outright Monetary Transactions) : promesse d''achats illimités de dette souveraine conditionnels à un programme EFSF/ESM. OMT n''a JAMAIS été activé — mais sa simple existence change le régime.',

  '[
    "Grèce : révision déficit 2009 de 6% à 15.4% PIB (oct 2009) → crise de confiance",
    "Grèce bailout 1 (mai 2010, 110 Md€) + bailout 2 (mars 2012, 130 Md€) + PSI haircut 53.5%",
    "Irlande bailout (nov 2010, 85 Md€) — crise banques (Anglo Irish Bank)",
    "Portugal bailout (avril 2011, 78 Md€)",
    "Espagne : bailout banques 100 Md€ (juin 2012), yields 10y 7.62% (24 juillet 2012)",
    "Italie : yields 10y 6.61% (juillet 2012), spread Bund 530bps",
    "Draghi ''whatever it takes'' (26 juillet 2012, Global Investment Conference London)",
    "ECB OMT program announcement (6 septembre 2012)",
    "Chypre bailout + bail-in dépôts (mars 2013)",
    "Greek PSI 53.5% haircut, largest sovereign debt restructuring de l''histoire (en notionnel)",
    "Sovereign-banking doom loop : banques EU capital ratios impactés par dette souveraine domestique"
  ]'::jsonb,

  '[
    "Déficit budgétaire révélé Grèce oct 2009 (15.4% PIB vs 6% annoncé) — confiance brisée",
    "Spread Bund-Bund rising depuis 2008 pour périphérie (Grèce, Irlande, Portugal) — indicateur clé",
    "CDS souverains périphériques en explosion depuis début 2010",
    "Banques EU en capital ratio sous pression permanente post-2008 (EBA stress test 2011 révèle des gaps)",
    "BCE sous Trichet resserre la politique (hike juillet 2011 à 1.50%) au milieu de la crise — erreur critique ex-post",
    "Euro project design flaw : union monétaire sans union fiscale/bancaire",
    "Target2 imbalances grandissants : créances allemandes vers BCE vs dettes périphériques"
  ]'::jsonb,

  '{
    "sovereign_yields_10y": {
      "greece": {"peak_pct": 44.21, "peak_date": "2012-03-09", "post_draghi_1y_pct": 9.0, "notes": "10y grec pique à 44% en mars 2012 (PSI), retombe à 9% un an après Draghi"},
      "portugal": {"peak_pct": 17.3, "peak_date": "2012-01-30", "post_draghi_1y_pct": 5.5, "notes": "Peak 17.3% janvier 2012, baisse à 5.5% un an après Draghi"},
      "ireland": {"peak_pct": 14.1, "peak_date": "2011-07-15", "post_draghi_1y_pct": 3.8, "notes": "Irlande restaure crédibilité plus vite (banking-only, pas sovereign)"},
      "spain": {"peak_pct": 7.62, "peak_date": "2012-07-24", "post_draghi_1y_pct": 4.3, "notes": "2 jours avant Draghi — tension maximale sur Espagne"},
      "italy": {"peak_pct": 6.61, "peak_date": "2012-07-24", "post_draghi_1y_pct": 4.3, "notes": "Idem peak même date"},
      "germany_bund": {"peak_drawdown_pct": 0.75, "peak_date": "2012-07-23", "notes": "Bund 10y chute à 1.18% (juillet 2012) — flight to quality intra-euro"}
    },
    "fx_eurusd": {
      "crisis_low_level": 1.20,
      "crisis_low_date": "2012-07-24",
      "post_draghi_2y_level": 1.39,
      "notes": "EUR/USD peak 1.60 (juillet 2008) → 1.20 (juillet 2012, post-crise) → 1.39 (mai 2014 post-Draghi). ''Whatever it takes'' reste le bottom EUR/USD de la crise."
    },
    "equity_eu": {
      "crisis_peak_drawdown_pct": -36.0,
      "peak_drawdown_date": "2011-09-22",
      "return_1y_post_draghi_pct": 26.0,
      "notes": "Euro Stoxx 50 2000 (avril 2011) → 1996 (sept 2011, -36% du pic 2009). Post-Draghi +26% sur 12 mois."
    },
    "equity_eu_banks": {
      "peak_drawdown_pct": -72.0,
      "notes": "STOXX Europe 600 Banks : de 180 (2011) à 85 (juillet 2012). ''Doom loop'' au pic."
    },
    "credit_eu_financials": {
      "spread_peak_bps": 550,
      "pre_crisis_bps": 150,
      "post_draghi_1y_bps": 180,
      "notes": "iTraxx Senior Financials CDS : 150bps pré-crise → 550bps (nov 2011) → 180bps (juillet 2013)."
    },
    "commodities_gold": {
      "level_crisis_peak_usd": 1900,
      "level_at_draghi_usd": 1605,
      "level_1y_post_draghi_usd": 1335,
      "notes": "Or pique à 1900$ en septembre 2011 sur la crise euro + downgrade US (S&P). Baisse progressive ensuite à mesure que la crise se résout."
    },
    "vix": {
      "peak_crisis_level": 48.0,
      "peak_date": "2011-08-08",
      "notes": "VIX spike août 2011 sur downgrade US + crise euro — dernière vraie spike avant 2018 volmageddon."
    },
    "us_10y_yield": {
      "crisis_low_pct": 1.43,
      "crisis_low_date": "2012-07-25",
      "notes": "US 10y touche 1.43% historic low au pic de la crise euro (1 jour avant Draghi) — flight to quality globale vers Treasuries."
    }
  }'::jsonb,

  '{
    "before": "Union monétaire perçue comme potentiellement irréversible — grande question de la crise. BCE cantonnée à un rôle strict d''inflation-target, pas de lender of last resort souverain. ''No bailout clause'' du Traité de Maastricht considéré comme sacrosaint.",
    "after": "BCE accepte implicitement le rôle de lender of last resort souverain (via OMT). Banking Union lancée (Single Supervisory Mechanism 2014, Single Resolution Mechanism 2015). ESM permanent (sept 2012) remplace EFSF. Mais union fiscale toujours bloquée — fragilité structurelle persiste. Retour latent avec la crise 2022 (écart Italie-Allemagne). OMT réactivable à tout moment mais jamais activé à ce jour."
  }'::jsonb,

  'L''intervention Draghi du 26 juillet 2012, complétée par OMT le 6 septembre 2012, est considérée comme LE moment de résolution. Yields périphériques compressent massivement sur les 18 mois suivants sans qu''OMT soit activé. BCE lance ensuite QE (ABS/covered bond purchase program sept 2014, full QE janvier 2015). La crise grecque continue sporadiquement jusqu''en 2015 (Tsipras, referendum, bail-in Chypre 2013, 3e bailout Grèce). Réellement ''close'' au sens économique fin 2013 (fin récession euro, spreads normalisés).',

  '[
    "Un discours de banquier central peut être le catalyst macroéconomique le plus impactant d''une décennie — ''whatever it takes'' vaut des centaines de milliards d''impact sans dépenser un euro",
    "La CRÉDIBILITÉ du message compte plus que l''exécution : OMT n''a jamais été utilisé, et pourtant a stabilisé",
    "Les crises souveraines ne peuvent être résolues sans un lender of last resort en devise locale — raison pour laquelle USD ne peut pas avoir de crise souveraine à la grecque (Fed peut imprimer illimité)",
    "Euro area avait un design flaw : monnaie commune sans trésor commun → la crise était structurelle, pas juste cyclique",
    "La ''doom loop'' sovereign-banking se casse avec Banking Union (SSM + SRM + Single Deposit Insurance incomplète)",
    "Les bailouts conditionnels (troika) ont un coût politique massif : austérité brutale → rise populisme (Syriza, M5S, Podemos) — impact durable sur politique EU",
    "Les marchés sous-estiment systématiquement les politiques de dernière minute quand la survie institutionnelle est en jeu — lesson pour traders short-souverain",
    "Central banks dépassent leur mandat formel sous pression existentielle (OMT est un détournement du TFEU art. 123 officiellement) — flexibilité politique > légalité stricte",
    "Asymétrie d''infos politiques : les marchés perçoivent l''échec avant la réussite",
    "Les crises bancaires et souveraines sont fondamentalement liées via la ''doom loop'' — ne jamais analyser l''une sans l''autre"
  ]'::jsonb,

  '[
    "Post-2012 : Banking Union partielle mais réelle — doom loop atténuée (pas éliminée)",
    "BCE a désormais QE normalisé dans son toolkit — outils plus diversifiés qu''en 2010",
    "MAIS : dette souveraine périphérique BEAUCOUP plus élevée qu''en 2010 (Italie 140% PIB, Grèce 170%) → fragilité latente",
    "Nouvelle crise souveraine EU serait probablement résolue plus vite via OMT ou équivalent — moins de temps de tension",
    "Mais contrainte inflation post-2022 limite la capacité BCE à QE comme en 2012-2015",
    "Setup à surveiller : Italie 10y yield spread vs Bund > 200bps sur plus de 3 mois = signal warning analog",
    "Le ''whatever it takes'' moment est irreprodutible — Draghi lui-même ne peut plus le faire (parti en 2019), Lagarde a un style différent",
    "Crise japonaise possible (dette 260% PIB, BoJ 50%+ JGB) aurait des dynamiques différentes — pas de risque euro-crisis, mais risque currency crisis"
  ]'::jsonb,

  array[
    'sovereign_crisis',
    'banking_crisis',
    'currency_crisis',
    'doom_loop',
    'central_bank_intervention',
    'flight_to_quality',
    'peripheral_vs_core_divergence',
    'policy_credibility_shock'
  ]::text[],

  'critical',
  'excellent',

  '[
    {"type":"speech","title":"Verbatim of the remarks made by Mario Draghi","authors":"Mario Draghi","year":2012,"url":"ecb.europa.eu/press/key/date/2012/html/sp120726.en.html"},
    {"type":"book","title":"The Euro: And Its Threat to the Future of Europe","authors":"Joseph Stiglitz","year":2016,"publisher":"W.W. Norton"},
    {"type":"book","title":"The Euro and the Battle of Ideas","authors":"Markus Brunnermeier, Harold James, Jean-Pierre Landau","year":2016,"publisher":"Princeton University Press"},
    {"type":"book","title":"Europe''s Orphan: The Future of the Euro and the Politics of Debt","authors":"Martin Sandbu","year":2015,"publisher":"Princeton University Press"},
    {"type":"paper","title":"The ECB''s OMT Programme and German Constitutional Concerns","authors":"Ashoka Mody","year":2015,"publisher":"Bruegel"},
    {"type":"data","title":"ECB Statistical Data Warehouse (yields, spreads, Target2)","publisher":"European Central Bank"}
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
