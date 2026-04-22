-- Migration 0020 — Corpus micro 2.3/5 : S&P 500 Bottom (9 mars 2009)
--
-- Le creux du bear market post-Lehman : ''Generational low'' qui marque
-- le début du plus long bull market de l''histoire US (mars 2009 - fév 2020,
-- 11 ans, interrompu seulement par la correction 2018).
--
-- Valeur pédagogique unique :
--   - Pattern classique du bottom ''capitulatoire'' + catalyst
--   - La divergence positive (bad news + market up) précède le rebond
--   - Les small caps et HY credit bottomaient AVANT les large caps
--   - Sentiment indicators (AAII bear %) atteignaient extrêmes historiques

insert into public.historical_events_corpus (
  slug, title, category, date_start, date_end, duration_description,
  context_description, key_drivers, preconditions,
  market_impact_by_asset_class, regime_shift, resolution,
  lessons_learned, limitations_of_comparison, similar_setups_tags,
  severity_at_peak, data_quality, references
) values (
  's_and_p_bottom_2009_march',
  'S&P 500 Generational Low + Bull Market Inception',
  'bubble_burst',
  '2009-03-09',
  '2009-04-02',
  'Bottom ponctuel puis rebond rapide (+23% en 20 jours post-bottom)',
  'Le 9 mars 2009, le S&P 500 touche 676.53 en intraday (low bear de 56.8% depuis pic oct 2007). La veille, Citigroup à 0.97$ (vs 55$ pré-crise), BofA à 3$. Panique totale sur les banques. Le 10 mars, Citigroup annonce rentabilité en janvier-février → rally de 6% sur le S&P. Le 18 mars, Fed expanse QE1 à 1.25 T$. Le 23 mars, PPIP (toxic assets buyback plan). Le 2 avril, G20 London annonce 1.1 T$ de stimulus global + triplement ressources IMF. Le bear market se termine ici : S&P 500 fait +39% en 3 mois, +65% en 12 mois. Les ''green shoots'' macro (Bernanke) apparaissent en mai 2009. Stress tests bancaires (7 mai 2009) confirment que les banques ont assez de capital → fin de l''incertitude systémique.',

  '[
    "Capitulation bancaire : Citigroup 0.97$ (mars 2009 low), BofA 3$, valuations implicites = faillite généralisée",
    "Catalyst bottom : Citigroup profitable en jan-fév 2009 (annonce 10 mars) → divergence positive",
    "QE1 expansion 1.25 T$ (18 mars 2009) — signal fort sur risk-on",
    "Stress tests bancaires SCAP (annoncés 25 fév, résultats 7 mai 2009) — transparence restaure confiance",
    "Extreme pessimism positioning : AAII Bear % à 70% (record historique), institutional cash levels à 20%",
    "Valuations absolues extrêmes : S&P 500 P/E trailing ~13x, P/B ~1.3x (plus bas que 1982)",
    "G20 London 2 avril 2009 : 1.1 T$ package coordonné global (IMF triplement, World Bank)"
  ]'::jsonb,

  '[
    "VIX à 80+ en octobre 2008 (peak panic déjà passé — typiquement le cas : max pain précède le low de 3-5 mois)",
    "Breadth extrêmement négatif : >90% des actions NYSE en bear (<-20%)",
    "Nombre de nouveaux 52-week lows = record (plus de 50% des actions)",
    "Put/Call ratio CBOE à 1.5+ (pic depuis 1995)",
    "HY credit spreads déjà en compression depuis décembre 2008 (précède equity bottom)",
    "Small caps (Russell 2000) bottomaient le 6 mars 2009, 3 jours avant large caps",
    "Inversion sentiment ''everyone bearish'' — contrarian bullish"
  ]'::jsonb,

  '{
    "equity_us_large": {
      "bottom_level": 676.53,
      "bottom_date": "2009-03-09",
      "return_1m_post_bottom_pct": 23.1,
      "return_3m_post_bottom_pct": 39.0,
      "return_12m_post_bottom_pct": 68.6,
      "return_5y_post_bottom_pct": 177.0,
      "return_10y_post_bottom_pct": 304.0,
      "notes": "S&P 500 676.53 → 2873 (2018) → 3386 (2020 pre-COVID). Probablement le meilleur entry point de la décennie."
    },
    "equity_us_small": {
      "bottom_date": "2009-03-09",
      "bottom_level": 343,
      "return_12m_post_bottom_pct": 97.0,
      "notes": "Russell 2000 de 343 à 679 (mars 2010). Small caps outperform massivement post-bottom."
    },
    "financials_sector": {
      "bottom_drawdown_pct": -83.0,
      "return_12m_post_bottom_pct": 148.0,
      "notes": "XLF (financials ETF) de 5.88 (mars 2009) à 17.10 (avril 2010). Les perdants de la crise deviennent les gagnants du rebond (deep value rotation)."
    },
    "credit_hy": {
      "spread_peak_bps": 2047,
      "spread_bottom_date": "2008-12-15",
      "spread_at_equity_bottom_bps": 1750,
      "spread_12m_later_bps": 630,
      "notes": "HY OAS had ALREADY bottomed in Dec 2008 — credit leads equity by 3 months. Compression de 1400bps en 12 mois post-equity bottom."
    },
    "govt_bonds_us_10y": {
      "yield_on_bottom_pct": 2.91,
      "yield_6m_later_pct": 3.46,
      "yield_1y_later_pct": 3.86,
      "notes": "Yields remontent à mesure que risque-on revient. Mais restent bas grace à QE."
    },
    "fx_dxy": {
      "peak_level": 89.0,
      "bottom_level_6m": 76.3,
      "move_pct": -14.3,
      "notes": "DXY baisse structurellement de mars 2009 à mi-2011."
    },
    "commodities_copper": {
      "bottom_price_usd_lb": 1.37,
      "price_12m_later_usd_lb": 3.40,
      "return_pct": 148.0,
      "notes": "Copper (Dr. Copper) de 1.37$ (déc 2008) à 3.40$ (fév 2010). ''Reflation trade'' : copper est proxy cyclique globale, leading indicator."
    },
    "commodities_gold": {
      "level_at_bottom_usd": 935,
      "level_12m_later_usd": 1100,
      "return_pct": 17.6,
      "notes": "Or continue de monter MÊME en risk-on — la narrative ''debasement'' via QE permet ce paradoxe."
    },
    "vix": {
      "peak": 80.86,
      "peak_date": "2008-10-24",
      "level_at_bottom": 49.7,
      "level_6m_later": 26.4,
      "notes": "VIX avait peaked en oct 2008, en déclin continu depuis. Pattern classique : VIX peak PRÉCÈDE equity low."
    }
  }'::jsonb,

  '{
    "before": "Paradigme ''end of capitalism'' narrative (Nouriel Roubini ''Mr. Doom'' star du moment). Capitulation fondamentale. Hedge funds fermés, banques zombies.",
    "after": "Démarrage bull market séculaire 2009-2020 (plus long de l''histoire US). ''Fed put'' intégré dans valuations. Passive investing (ETFs) décollent massivement. Stratégies ''buy the dip'' deviennent dominantes."
  }'::jsonb,

  'Le bottom n''a pas été identifié ex-ante (fev-mars 2009, sentiment apocalyptique persistant). Stress tests (7 mai 2009) confirment la recapitalisation, débloquant la confiance. S&P 500 retrouve le niveau pré-Lehman (~1250) en mars 2011. Retour au peak d''octobre 2007 (1565) le 28 mars 2013 (4 ans 0 jours).',

  '[
    "Les bottoms se font quand personne n''y croit — AAII Bear %, cash levels, Put/Call records = signaux contrarian puissants",
    "Credit spreads (HY OAS) pivotent 3-6 mois AVANT les equity — Claude doit surveiller ce leading indicator",
    "Small caps et sectors les plus battus (financials -83%) outperforment massivement dans les 12m post-bottom",
    "VIX peak PRÉCÈDE typiquement equity low de plusieurs mois (Oct 2008 VIX peak, Mars 2009 equity low)",
    "La ''positive divergence'' (bad news + market ne baisse plus) est le meilleur bottom signal",
    "Monetary & fiscal coordinated response = catalyseur : QE expansion + PPIP + G20 stimulus sur 3 semaines",
    "Les valuations absolues (P/E, P/B, dividend yield) deviennent attractives AVANT le bottom, mais ne suffisent pas à elles seules — il faut un catalyst",
    "Le ''greatest trade ever'' de John Paulson (short subprime) avait pivoté LONG en fev 2009 — les smart money voient les bottoms",
    "Bull markets naissent dans le pessimisme, croissent dans le scepticisme, mûrissent dans l''optimisme, meurent dans l''euphorie (John Templeton)"
  ]'::jsonb,

  '[
    "Bottoms ''V-shaped'' comme 2009 (catalyseur politique fort + stimulus coordonné) vs bottoms ''U'' ou ''L'' (2000-2003, Japan 1990s) — dépend de la politique monétaire",
    "2009 avait inflation en recul vers 0% → QE possible sans contrainte. Une bear market future avec inflation élevée n''aurait pas ce confort",
    "Valuations de départ 2009 (P/E 13x) très basses — les bottoms actuels partent souvent de valuations plus élevées, moins de marge",
    "Positioning extrême en 2009 (AAII bear 70%) — difficile de revoir ces niveaux sans crise comparable",
    "Post-2009 a bénéficié d''une décennie de ZIRP — régime aujourd''hui différent"
  ]'::jsonb,

  array[
    'market_bottom',
    'bull_market_inception',
    'capitulation',
    'contrarian_signal',
    'coordinated_policy_response',
    'credit_leads_equity',
    'sentiment_extreme'
  ]::text[],

  'watch',
  'excellent',

  '[
    {"type":"data","title":"S&P 500 historical prices & returns","publisher":"Yahoo Finance / CRSP"},
    {"type":"paper","title":"Investor Sentiment in the Stock Market","authors":"Baker, Wurgler","year":2007,"publisher":"Journal of Economic Perspectives"},
    {"type":"paper","title":"Credit Spreads as Leading Indicators","authors":"Gilchrist, Zakrajsek","year":2012},
    {"type":"book","title":"Bull! A History of the Boom and Bust","authors":"Maggie Mahar","year":2003},
    {"type":"data","title":"AAII Investor Sentiment Survey","publisher":"American Association of Individual Investors"}
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
