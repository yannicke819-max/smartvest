-- Migration 0018 — Corpus micro 2.1/5 : Lehman Brothers Collapse (15 sept 2008)
--
-- Événement fondateur post-2000. Passage d'une crise subprime à une crise
-- systémique globale via contagion interbancaire, effondrement liquidité
-- dollaire, et bascule de régime monétaire (ZIRP + QE pour une décennie).
--
-- Valeur pour l'AI analyst :
--   - Pattern de banking crisis + liquidity crunch + leverage unwind
--   - Précurseur des réponses non-conventionnelles des banques centrales
--   - Test case pour analogs de stress systémique (SVB 2023 partage des
--     signaux précurseurs mais pas l'ampleur systémique)
--   - Référence pour le "flight to dollar" paradoxal (le dollar monte
--     MÊME quand la crise vient des US, à cause du funding court offshore)

insert into public.historical_events_corpus (
  slug,
  title,
  category,
  date_start,
  date_end,
  duration_description,
  context_description,
  key_drivers,
  preconditions,
  market_impact_by_asset_class,
  regime_shift,
  resolution,
  lessons_learned,
  limitations_of_comparison,
  similar_setups_tags,
  severity_at_peak,
  data_quality,
  source_references
) values (
  'lehman_2008_collapse',
  'Lehman Brothers Bankruptcy & Global Financial Crisis Acute Phase',
  'systemic_crisis',
  '2008-09-15',
  '2009-03-09',
  'Phase aiguë ~6 mois du dépôt de bilan Lehman au creux du S&P 500',
  'Le 15 septembre 2008, Lehman Brothers dépose le Chapter 11 avec 639 Md$ d''actifs — la plus grosse faillite de l''histoire US. L''événement n''est pas une surprise complète (la chute se construit depuis Bear Stearns en mars) mais sa modalité — la Fed et le Trésor refusent le bailout après avoir sauvé Bear Stearns — déclenche une panique que les marchés n''avaient pas pricé. En 72h, le Reserve Primary Fund ''break the buck'' (NAV < 1$), déclenchant un bank-run sur les money market funds pour 500+ Md$. Les spreads interbancaires (TED, LIBOR-OIS) explosent, le commercial paper market s''arrête. AIG est nationalisé le 16. La panique est GLOBALE : banques européennes (RBS, Fortis, Dexia), islandaises (Kaupthing, Glitnir, Landsbanki) tombent dans les semaines suivantes. Le S&P 500 perd 46% supplémentaires de septembre au creux de mars 2009.',

  -- key_drivers
  '[
    "Chapter 11 Lehman Brothers (639 Md$ d''actifs, pas de bailout)",
    "Reserve Primary Fund break the buck → bank-run sur MMFs (500+ Md$ retirés en quelques jours)",
    "Leverage bancaire 30-40x via shadow banking (SIV, conduits, repo overnight)",
    "Interconnexion CDS — AIG (nationalisé 16 sept) était contrepartie de 440 Md$ en CDS",
    "Gel du marché interbancaire et commercial paper (40% du financement court US)",
    "Contagion globale via funding dollar offshore — banques EU avaient 2+ T$ de dette USD court non-hedged",
    "Deleveraging forcé : hedge funds margin calls, ventes forcées de titres liquides"
  ]'::jsonb,

  -- preconditions (signaux 6-18 mois avant l''événement)
  '[
    "Bear Stearns collapse + JP Morgan rescue (16 mars 2008) — premier choc majeur",
    "Case-Shiller Home Price Index en chute continue depuis juillet 2006 (-20% au moment Lehman)",
    "Fannie Mae & Freddie Mac conservatorship (7 sept 2008, 8 jours avant Lehman)",
    "ABX index (subprime MBS) effondré de -95% depuis mi-2007",
    "TED spread passé de 50bps (normal) à 200+bps dès août 2007 (BNP Paribas freeze 3 fonds)",
    "3m LIBOR-OIS spread > 100bps (normal 10bps) dès septembre 2007",
    "Fed avait déjà coupé de 5.25% (sept 2007) à 2% (avril 2008) sans stabiliser",
    "S&P 500 déjà -23% depuis son pic d''octobre 2007 (1565 → 1251 au 15 sept 2008)",
    "Inversion courbe 2s10s jusqu''à -50bps en 2006-2007",
    "VIX persistant > 20 depuis août 2007 (vs moyenne LT ~16)"
  ]'::jsonb,

  -- market_impact_by_asset_class (le cœur de la valeur du corpus)
  '{
    "equity_us_large": {
      "peak_drawdown_pct": -56.8,
      "peak_drawdown_date": "2009-03-09",
      "duration_to_trough_days": 517,
      "duration_to_recovery_days": 1481,
      "pre_event_move_6m_pct": -11.3,
      "notes": "S&P 500 peak 1565.15 (9 oct 2007) → trough 676.53 (9 mars 2009). Retour au pic précédent 28 mars 2013."
    },
    "equity_us_small": {
      "peak_drawdown_pct": -58.9,
      "notes": "Russell 2000 peak 856 (juillet 2007) → trough 343 (mars 2009). Small caps amplifient en crise liquidité."
    },
    "equity_eu": {
      "peak_drawdown_pct": -60.3,
      "peak_drawdown_date": "2009-03-09",
      "notes": "Euro Stoxx 50 peak 4557 (juillet 2007) → trough 1810 (mars 2009). Banques EU plus impactées que US banques."
    },
    "equity_em": {
      "peak_drawdown_pct": -66.1,
      "notes": "MSCI EM peak 1338 (oct 2007) → trough 454 (oct 2008). Decoupling narrative pulvérisée."
    },
    "equity_jp": {
      "peak_drawdown_pct": -51.6,
      "notes": "Nikkei 225 peak 18300 (juillet 2007) → trough 7054 (mars 2009). Yen en safe-haven massive."
    },
    "govt_bonds_us_10y": {
      "yield_peak_pct": 5.10,
      "yield_peak_date": "2007-06-12",
      "yield_trough_pct": 2.05,
      "yield_trough_date": "2008-12-18",
      "yield_move_bps": -305,
      "notes": "Flight to quality massif. Courbe très steep à partir de décembre 2008 (Fed à 0%, 10y à 2-4%)."
    },
    "govt_bonds_us_2y": {
      "yield_peak_pct": 5.25,
      "yield_trough_pct": 0.66,
      "notes": "Front-end anchored à 0 dès déc 2008 suite à ZIRP."
    },
    "credit_ig": {
      "spread_peak_bps": 620,
      "spread_peak_date": "2008-12-15",
      "pre_event_bps": 215,
      "spread_widening_bps": 405,
      "notes": "BBB US IG OAS de 215bps (août 2008) à 620bps (déc 2008). Jamais vu depuis Grande Dépression."
    },
    "credit_hy": {
      "spread_peak_bps": 2047,
      "spread_peak_date": "2008-12-15",
      "pre_event_bps": 600,
      "spread_widening_bps": 1447,
      "notes": "US HY OAS 600bps (août 2008) → 2047bps (déc 2008). Record historique ex-1933."
    },
    "commodities_oil_brent": {
      "peak_drawdown_pct": -78.0,
      "peak_drawdown_date": "2008-12-23",
      "pre_event_move_6m_pct": -18.0,
      "notes": "Brent de $147 (11 juillet 2008, pic hist.) → $33 (déc 2008). Effondrement demande + deleveraging des trades commodities."
    },
    "commodities_gold": {
      "peak_return_12m_pct": 25.0,
      "trough_during_crisis_pct": -28.0,
      "notes": "Safe-haven MAIS deleveraging forcé : de $1011 (mars 2008) à $712 (oct 2008) AVANT rally à $900 (fév 2009) puis $1900 (sept 2011). Pattern important : or peut être forcé vendu en phase 1 liquidity crunch, devient safe-haven en phase 2."
    },
    "fx_dxy": {
      "peak_move_pct": 24.5,
      "peak_date": "2009-03-04",
      "pre_event_level": 71.3,
      "peak_level": 89.0,
      "notes": "USD Index de 71.3 (juillet 2008, creux hist.) à 89 (mars 2009). Paradoxe du flight-to-dollar malgré crise US origin — explication : funding dollar offshore non-hedged."
    },
    "fx_eurusd": {
      "peak_move_pct": -22.5,
      "notes": "EUR/USD de 1.60 (juillet 2008) à 1.24 (oct 2008). Banques EU désespérément short USD."
    },
    "fx_usdjpy": {
      "peak_move_pct": -23.0,
      "notes": "USD/JPY de 110 (août 2008) à 87 (déc 2008). Yen safe-haven via unwind carry trades."
    },
    "vix": {
      "peak": 89.53,
      "peak_date": "2008-10-24",
      "pre_event_level": 25,
      "notes": "VIX intraday peak 89.53, daily close peak 80.86. Jamais dépassé jusqu''à mars 2020 (COVID)."
    }
  }'::jsonb,

  -- regime_shift
  '{
    "before": "Fed funds 2-5%, QE absent du vocabulaire, shadow banking non régulé, bank leverage 30x, money market funds NAV stable tenue pour acquise, bail-out banques refusé idéologiquement",
    "after": "ZIRP décennale (2008-2015), QE permanent (QE1 nov 2008, QE2 nov 2010, QE3 sept 2012), Dodd-Frank 2010, stress tests annuels, bank leverage cappé à ~10-15x, Basel III (capital requirements renforcés), MMF reform 2014+2016, swap lines Fed permanentes vers banques centrales étrangères",
    "monetary_regime": "passage d''un régime taux conventionnel à un régime de bilan élargi (balance sheet-driven)",
    "equity_regime": "post-2009 un des plus longs bull markets hist. (mars 2009 - fév 2020 = 11 ans), avec une seule correction >20% ponctuelle (2018)"
  }'::jsonb,

  -- resolution
  'Stabilisation progressive sur 2009-2010 via : (1) TARP 700 Md$ (oct 2008), (2) Fed discount window élargi, swap lines avec BCE/BoE/BoJ/BNS (oct-déc 2008), (3) ZIRP + QE1 (nov 2008), (4) stress tests bancaires (mai 2009, confiance restaurée), (5) ARRA fiscal stimulus 831 Md$ (fév 2009), (6) Dodd-Frank Act (juillet 2010). S&P 500 bottome le 9 mars 2009 à 676.53, rebond +65% sur 12 mois. Crise euro (2010-2012) est le relais direct — banques EU restent fragiles après 2008.',

  -- lessons_learned
  '[
    "L''interconnexion crée contagion — actifs non-corrélés deviennent corrélés en crise (la corrélation monte vers 1 en panique)",
    "Le funding court (repo, commercial paper) est le point de fragilité réel, pas le capital",
    "Money market funds peuvent ''break the buck'' — système fondamentalement fragile, réformé depuis",
    "Central banks deviennent le lender of last resort ultime — et ne peuvent plus sortir de ce rôle (ZIRP/QE sont cliquet unidirectionnel)",
    "Le dollar monte en crise SYSTÉMIQUE même si la crise vient des US (short USD offshore massif doit se hedger)",
    "Or peut être forcé vendu en phase 1 d''une liquidity crunch (deleveraging), devient safe-haven seulement en phase 2",
    "Les crises financières durent 3-5× plus longtemps que les récessions normales (Reinhart & Rogoff : ''This Time Is Different'')",
    "Les yields courbes inversées 12-18 mois avant le pic des actions — signal empirique",
    "Les spreads crédit (IG et HY) widening précède la récession de 3-6 mois",
    "La regulation post-crise sur-corrige typiquement (Dodd-Frank 2300 pages) et crée les fragilités de la crise suivante (shadow banking → dealer intermediation)"
  ]'::jsonb,

  -- limitations_of_comparison
  '[
    "Basel III : bank leverage divisé par 3 (30x → 10-15x) — une nouvelle crise bancaire majeure aurait moins d''amplification",
    "Stress tests annuels (CCAR) — les banques US sont auditées en continu, moins de surprise possible",
    "Money market reform (2014+2016) : MMFs institutionnels floating NAV, pas de nouveau ''break the buck''",
    "Dodd-Frank orderly resolution authority — une grande banque en faillite peut être résolue sans contagion (théorie)",
    "Fed a maintenant des outils : swap lines permanentes, FIMA repo facility, ample reserves framework",
    "2008 était UNIQUEMENT US-origin et a contaminé le monde ; 2023 SVB était aussi US-origin mais contagion contenue rapidement",
    "PAS applicable si la crise suivante vient de l''ailleurs : souveraine (Japon debt ratio 260% PIB), FX EM, crypto systémique, immobilier commercial",
    "Le repertoire des banques centrales est désormais CONNU — effet de surprise plus limité pour un QE4 ou équivalent"
  ]'::jsonb,

  -- similar_setups_tags
  array[
    'banking_crisis',
    'systemic_crisis',
    'liquidity_crunch',
    'global_contagion',
    'credit_event',
    'leverage_unwind',
    'funding_crisis',
    'regime_shift_monetary',
    'flight_to_quality',
    'flight_to_dollar'
  ]::text[],

  'systemic',
  'excellent',

  '[
    {"type":"book","title":"The Courage to Act","authors":"Ben S. Bernanke","year":2015,"publisher":"W.W. Norton"},
    {"type":"book","title":"Too Big to Fail","authors":"Andrew Ross Sorkin","year":2009,"publisher":"Viking"},
    {"type":"book","title":"The End of Wall Street","authors":"Roger Lowenstein","year":2010,"publisher":"Penguin Press"},
    {"type":"book","title":"This Time Is Different: Eight Centuries of Financial Folly","authors":"Carmen Reinhart, Kenneth Rogoff","year":2009,"publisher":"Princeton University Press"},
    {"type":"report","title":"The Financial Crisis Inquiry Report","authors":"FCIC","year":2011,"publisher":"US Government"},
    {"type":"paper","title":"The Federal Reserve''s Response to the Financial Crisis","authors":"Federal Reserve","year":2013,"url":"federalreserve.gov"},
    {"type":"paper","title":"International banking and liquidity risk transmission","authors":"BIS Working Paper 400","year":2013},
    {"type":"data","title":"FRED Economic Data (Fed Funds, VIX, TED Spread, OAS)","publisher":"St. Louis Fed"}
  ]'::jsonb
)
on conflict (slug) do update set
  title = excluded.title,
  category = excluded.category,
  date_start = excluded.date_start,
  date_end = excluded.date_end,
  duration_description = excluded.duration_description,
  context_description = excluded.context_description,
  key_drivers = excluded.key_drivers,
  preconditions = excluded.preconditions,
  market_impact_by_asset_class = excluded.market_impact_by_asset_class,
  regime_shift = excluded.regime_shift,
  resolution = excluded.resolution,
  lessons_learned = excluded.lessons_learned,
  limitations_of_comparison = excluded.limitations_of_comparison,
  similar_setups_tags = excluded.similar_setups_tags,
  severity_at_peak = excluded.severity_at_peak,
  data_quality = excluded.data_quality,
  source_references = excluded.source_references,
  updated_at = now();
