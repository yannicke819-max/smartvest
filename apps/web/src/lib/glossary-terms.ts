export type GlossaryCategory =
  | 'finance'
  | 'risque'
  | 'plateforme'
  | 'strategie';

export interface GlossaryTerm {
  slug: string;
  term: string;
  definition: string;
  example?: string;
  related?: string[];
  category: GlossaryCategory;
}

export const CATEGORY_LABELS: Record<GlossaryCategory, string> = {
  finance: 'Finance de base',
  risque: 'Risque',
  plateforme: 'Plateforme SmartVest',
  strategie: 'Stratégie',
};

export const GLOSSARY_TERMS: GlossaryTerm[] = [
  // ── Finance de base ──────────────────────────────────────────────
  {
    slug: 'portefeuille',
    term: 'Portefeuille',
    definition:
      "L'ensemble de vos actifs financiers (actions, obligations, ETF, crypto…) détenus dans un ou plusieurs comptes.",
    example: 'Un portefeuille de 10 000 € peut contenir 60 % d\'actions, 30 % d\'obligations et 10 % de liquidités.',
    related: ['allocation', 'diversification'],
    category: 'finance',
  },
  {
    slug: 'action',
    term: 'Action',
    definition:
      "Titre représentant une part de propriété d'une entreprise. Détenir une action donne droit aux dividendes et à une fraction des bénéfices.",
    example: 'Acheter 10 actions Apple à 180 $ = détenir 0,0000001 % d\'Apple.',
    related: ['dividende', 'plus-value'],
    category: 'finance',
  },
  {
    slug: 'obligation',
    term: 'Obligation',
    definition:
      "Titre de dette émis par une entreprise ou un État. L'émetteur s'engage à rembourser le capital et à verser des intérêts périodiques (coupon).",
    example: 'Obligation d\'État français à 10 ans : coupon 3 %, remboursée à 100 % à l\'échéance.',
    related: ['rendement', 'risque-de-marche'],
    category: 'finance',
  },
  {
    slug: 'etf',
    term: 'ETF (Fonds indiciel coté)',
    definition:
      "Fonds coté en bourse qui réplique un indice (CAC 40, S&P 500…). Permet une diversification instantanée à faible coût.",
    example: 'Un ETF S&P 500 expose à 500 entreprises américaines avec un seul achat.',
    related: ['diversification', 'allocation'],
    category: 'finance',
  },
  {
    slug: 'dividende',
    term: 'Dividende',
    definition:
      "Part des bénéfices d'une entreprise reversée aux actionnaires, généralement trimestriellement ou annuellement.",
    example: 'Total Energies verse ~8 % de dividende annuel. 1 000 € investi rapporte ~80 €/an sans compter la variation de cours.',
    related: ['action', 'rendement'],
    category: 'finance',
  },
  {
    slug: 'rendement',
    term: 'Rendement',
    definition:
      "Gain ou perte généré par un investissement sur une période, exprimé en pourcentage du capital investi.",
    example: '1 000 € → 1 080 € en un an = rendement de +8 %.',
    related: ['plus-value', 'dividende'],
    category: 'finance',
  },
  {
    slug: 'plus-value',
    term: 'Plus-value',
    definition:
      "Gain réalisé lors de la vente d'un actif à un prix supérieur à son prix d'achat.",
    example: 'Achat à 50 €, vente à 65 € = plus-value de 15 € (30 %).',
    related: ['moins-value', 'rendement'],
    category: 'finance',
  },
  {
    slug: 'moins-value',
    term: 'Moins-value',
    definition:
      "Perte réalisée lors de la vente d'un actif à un prix inférieur à son prix d'achat.",
    example: 'Achat à 50 €, vente à 40 € = moins-value de 10 € (−20 %).',
    related: ['plus-value', 'stop-loss'],
    category: 'finance',
  },
  {
    slug: 'liquidite',
    term: 'Liquidité',
    definition:
      "Facilité à convertir un actif en argent rapidement sans perte de valeur significative. Une action très liquide se vend instantanément au cours affiché.",
    example: 'Apple est très liquide (millions de titres échangés/jour). Une petite foncière est peu liquide.',
    related: ['portefeuille'],
    category: 'finance',
  },
  {
    slug: 'interets-composes',
    term: 'Intérêts composés',
    definition:
      "Mécanisme où les rendements générés s'ajoutent au capital et génèrent eux-mêmes des rendements. L'effet s'accélère dans le temps.",
    example: '10 000 € à 8 %/an pendant 30 ans = 100 627 € sans apport supplémentaire.',
    related: ['rendement'],
    category: 'finance',
  },
  {
    slug: 'cours',
    term: 'Cours (prix de marché)',
    definition:
      "Prix actuel auquel un actif s'échange sur le marché. Fluctue en continu pendant les heures d'ouverture.",
    example: 'Le cours d\'Apple à 10h32 EST est 187,40 $. Dans 5 minutes, il peut être 187,80 $.',
    related: ['volatilite'],
    category: 'finance',
  },
  {
    slug: 'capitalisation-boursiere',
    term: 'Capitalisation boursière',
    definition:
      "Valeur totale d'une entreprise selon les marchés : nombre d'actions × cours actuel.",
    example: 'Apple à 3 000 Mds$ = entreprise la plus valorisée au monde.',
    related: ['action'],
    category: 'finance',
  },

  // ── Risque ──────────────────────────────────────────────────────
  {
    slug: 'drawdown',
    term: 'Drawdown (baisse maximale)',
    definition:
      "Baisse maximale depuis un pic de valeur jusqu'au creux suivant. Mesure l'ampleur d'une perte temporaire pendant une phase baissière.",
    example: 'Portefeuille à 12 000 € → chute à 9 600 € = drawdown de −20 %.',
    related: ['volatilite', 'stop-loss'],
    category: 'risque',
  },
  {
    slug: 'volatilite',
    term: 'Volatilité',
    definition:
      "Amplitude des variations de prix d'un actif sur une période. Une forte volatilité signifie des fluctuations importantes, à la hausse comme à la baisse.",
    example: 'Le Bitcoin peut varier de ±10 % en une journée. L\'OR varie rarement de plus de ±2 %.',
    related: ['drawdown', 'risque-de-marche'],
    category: 'risque',
  },
  {
    slug: 'risque-de-marche',
    term: 'Risque de marché',
    definition:
      "Perte potentielle liée aux fluctuations générales des marchés financiers, indépendamment de la qualité de l'actif choisi.",
    example: 'En 2022, même les meilleures entreprises ont chuté de 20-40 % avec la hausse des taux.',
    related: ['diversification', 'volatilite'],
    category: 'risque',
  },
  {
    slug: 'stop-loss',
    term: 'Stop-loss (seuil de perte)',
    definition:
      "Ordre automatique de vente d'un actif lorsque son prix baisse jusqu'à un niveau défini. Protège contre les pertes excessives.",
    example: 'Position achetée à 100 €, stop-loss à −5 % = vente automatique à 95 €.',
    related: ['take-profit', 'drawdown'],
    category: 'risque',
  },
  {
    slug: 'take-profit',
    term: 'Take-profit (seuil de gain)',
    definition:
      "Ordre automatique de vente d'un actif lorsque son prix atteint un niveau de gain défini. Matérialise les profits avant un éventuel retournement.",
    example: 'Position achetée à 100 €, take-profit à +10 % = vente automatique à 110 €.',
    related: ['stop-loss', 'rendement'],
    category: 'risque',
  },
  {
    slug: 'profil-de-risque',
    term: 'Profil de risque',
    definition:
      "Classification de votre tolérance aux pertes et de votre horizon d'investissement. Détermine les types d'actifs et de stratégies adaptés.",
    example: 'Profil Prudent : peu de volatilité, beaucoup d\'obligations. Profil Offensif : forte expo actions, accepte −50 %.',
    related: ['drawdown', 'allocation'],
    category: 'risque',
  },
  {
    slug: 'pnl-latent',
    term: 'P&L latent',
    definition:
      "Gain ou perte non encore réalisé sur des positions encore ouvertes. Disparaît si le cours revient à l'entrée, se matérialise à la clôture.",
    example: 'Position ouverte à 100 €, cours actuel 115 € → P&L latent +15 € (non encaissé).',
    related: ['plus-value', 'moins-value'],
    category: 'risque',
  },
  {
    slug: 'vix',
    term: 'VIX (indice de volatilité)',
    definition:
      "Indice mesurant la volatilité implicite du marché américain S&P 500 pour les 30 prochains jours. Souvent appelé « thermomètre de la peur ».",
    example: 'VIX < 15 = marché calme. VIX > 30 = stress important. VIX > 50 = panique (mars 2020).',
    related: ['volatilite', 'risque-de-marche'],
    category: 'risque',
  },
  {
    slug: 'correlation',
    term: 'Corrélation',
    definition:
      "Mesure statistique (−1 à +1) de la relation entre deux actifs. +1 = évoluent en même temps, −1 = évoluent en sens inverse, 0 = indépendants.",
    example: 'Or et dollar USD ont souvent une corrélation négative : quand le dollar baisse, l\'or monte.',
    related: ['diversification', 'allocation'],
    category: 'risque',
  },

  // ── Plateforme SmartVest ─────────────────────────────────────────
  {
    slug: 'simulation',
    term: 'Simulation (portefeuille virtuel)',
    definition:
      "Portefeuille 100 % virtuel : aucun argent réel engagé, aucun ordre transmis à un broker. Permet de tester des stratégies sans risque financier.",
    related: ['capital-de-travail'],
    category: 'plateforme',
  },
  {
    slug: 'lisa',
    term: 'Lisa (assistant IA)',
    definition:
      "L'assistant d'analyse de SmartVest. Lisa analyse les marchés, génère des scénarios et des suggestions. Elle ne prend jamais de décision autonome sans votre autorisation explicite.",
    related: ['mode-delegation', 'mandat'],
    category: 'plateforme',
  },
  {
    slug: 'mode-delegation',
    term: 'Mode de délégation',
    definition:
      "Niveau d'autonomie accordé à Lisa : Manuel (analyse seule), Hybride (suggestions à valider), Autonome gardé (agit dans un mandat strictement défini).",
    related: ['mandat', 'kill-switch'],
    category: 'plateforme',
  },
  {
    slug: 'mandat',
    term: 'Mandat d\'autonomie',
    definition:
      "Règles définissant les limites dans lesquelles Lisa peut agir de façon autonome : taille max des positions, classes d'actifs autorisées, stop-loss obligatoire, date d'expiration.",
    related: ['kill-switch', 'mode-delegation'],
    category: 'plateforme',
  },
  {
    slug: 'kill-switch',
    term: 'Kill-switch (arrêt d\'urgence)',
    definition:
      "Bouton d'arrêt immédiat de tout automatisme. Ferme toutes les positions simulées et désactive l'autopilot. Toujours accessible, jamais masqué.",
    related: ['mandat', 'mode-delegation'],
    category: 'plateforme',
  },
  {
    slug: 'mode-investment',
    term: 'Mode Investment',
    definition:
      "Stratégie long terme (buy-and-hold). Lisa analyse les marchés toutes les 60 minutes et privilégie des thèses à horizon semaines/mois. Stops larges (4 %).",
    related: ['mode-harvest', 'mode-gainers'],
    category: 'plateforme',
  },
  {
    slug: 'mode-harvest',
    term: 'Mode Harvest (récolte intraday)',
    definition:
      "Stratégie de scalping intraday. Lisa analyse toutes les 7 minutes, vise des gains de 1,5-2,5 % par trade, avec un stop serré à 1,5 %. Les gains réalisés sont transférés dans un vault sécurisé.",
    related: ['mode-investment', 'vault-securise', 'capital-de-travail'],
    category: 'plateforme',
  },
  {
    slug: 'mode-gainers',
    term: 'Mode Gainers (scanner momentum)',
    definition:
      "Scanner automatique de valeurs en forte hausse sur 1 minute, vérifié sur plusieurs horizons (5, 15, 30, 60 min). Purement déterministe, bypass le LLM.",
    related: ['mode-harvest', 'mode-investment'],
    category: 'plateforme',
  },
  {
    slug: 'capital-de-travail',
    term: 'Capital de travail',
    definition:
      "Montant alloué aux positions actives de Lisa. Reste fixe en mode Harvest : les gains réalisés partent dans le vault et ne sont pas réinjectés.",
    related: ['vault-securise', 'mode-harvest'],
    category: 'plateforme',
  },
  {
    slug: 'vault-securise',
    term: 'Vault sécurisé (gains préservés)',
    definition:
      "Compartiment de gains réalisés non réinjectables dans le capital de trading. En mode Harvest, chaque trade gagnant verse immédiatement ses profits dans le vault.",
    related: ['capital-de-travail', 'mode-harvest'],
    category: 'plateforme',
  },
  {
    slug: 'autopilot',
    term: 'Autopilot',
    definition:
      "Mode où Lisa exécute automatiquement ses propositions dans le cadre du mandat. Uniquement en simulation paper — aucun ordre réel sans configuration broker dédiée.",
    related: ['mandat', 'kill-switch'],
    category: 'plateforme',
  },

  // ── Stratégie ────────────────────────────────────────────────────
  {
    slug: 'allocation',
    term: 'Allocation d\'actifs',
    definition:
      "Répartition du portefeuille entre différentes classes d'actifs (actions, obligations, immobilier, liquidités…). Détermine le couple rendement/risque global.",
    example: 'Allocation 60/40 : 60 % actions, 40 % obligations. Typique d\'un profil équilibré.',
    related: ['diversification', 'rééquilibrage'],
    category: 'strategie',
  },
  {
    slug: 'diversification',
    term: 'Diversification',
    definition:
      "Répartir ses investissements sur différents actifs, secteurs et géographies pour réduire le risque global sans nécessairement réduire le rendement attendu.",
    example: 'Ne pas mettre tous ses œufs dans le même panier : 1 seule action = risque max. 50 actions = risque fortement réduit.',
    related: ['allocation', 'correlation'],
    category: 'strategie',
  },
  {
    slug: 'rééquilibrage',
    term: 'Rééquilibrage',
    definition:
      "Ajustement périodique du portefeuille pour restaurer l'allocation cible, après que les variations de cours ont déformé les proportions initiales.",
    example: 'Cible 60/40 → après hausse des actions : 70/30. Rééquilibrage = vendre des actions, acheter des obligations.',
    related: ['allocation'],
    category: 'strategie',
  },
  {
    slug: 'horizon-investissement',
    term: 'Horizon d\'investissement',
    definition:
      "Durée pendant laquelle vous prévoyez de conserver vos investissements avant d'en avoir besoin. Plus l'horizon est long, plus vous pouvez accepter de volatilité.",
    example: 'Retraite dans 25 ans = horizon long, actions agressives acceptables. Achat immobilier dans 2 ans = horizon court, capital à protéger.',
    related: ['profil-de-risque', 'volatilite'],
    category: 'strategie',
  },
  {
    slug: 'levier',
    term: 'Levier financier',
    definition:
      "Multiplication de l'exposition d'un investissement par rapport au capital réellement investi. Amplifie gains et pertes de façon symétrique.",
    example: 'Levier 2× sur 1 000 € = exposition de 2 000 €. Si l\'actif monte de 10 % → +200 €. S\'il baisse de 10 % → −200 €.',
    related: ['drawdown', 'risque-de-marche'],
    category: 'strategie',
  },
  {
    slug: 'momentum',
    term: 'Momentum',
    definition:
      "Tendance d'un actif à poursuivre sa direction récente. Stratégie basée sur l'achat d'actifs en hausse et la vente d'actifs en baisse.",
    related: ['mode-gainers'],
    category: 'strategie',
  },
  {
    slug: 'scalping',
    term: 'Scalping',
    definition:
      "Stratégie à très court terme visant des gains rapides et faibles (0,5-2,5 %) sur de nombreuses transactions. Requiert une forte discipline sur les stops.",
    related: ['mode-harvest', 'stop-loss', 'take-profit'],
    category: 'strategie',
  },
  {
    slug: 'position',
    term: 'Position',
    definition:
      "Détention d'un actif financier (long = acheté, short = vendu à découvert). Une position ouverte expose au risque de marché jusqu'à sa clôture.",
    related: ['pnl-latent', 'stop-loss'],
    category: 'strategie',
  },
  {
    slug: 'hedging',
    term: 'Hedging (couverture)',
    definition:
      "Stratégie consistant à prendre une position compensatrice pour réduire le risque d'une position existante. Réduit les gains potentiels, mais limite les pertes.",
    example: 'Détenir des actions technologiques + acheter des options put sur le Nasdaq = couverture contre une chute du secteur tech.',
    related: ['risque-de-marche', 'correlation'],
    category: 'strategie',
  },

  // ── Sprint 2 — Complément glossaire grand public (ADR-002 §3) ────
  // Termes finance / fiscalité / produits
  {
    slug: 'pea',
    term: 'PEA (Plan d\'Épargne en Actions)',
    definition:
      "Enveloppe fiscale française permettant d'investir en actions européennes. Après 5 ans de détention, les plus-values sont exonérées d'impôt (hors prélèvements sociaux 17,2 %).",
    example: 'PEA ouvert en 2020, retrait en 2025 : 10 000 € de plus-value taxée uniquement à 17,2 % au lieu de 30 % en CTO.',
    related: ['cto', 'plus-value', 'flat-tax'],
    category: 'finance',
  },
  {
    slug: 'cto',
    term: 'CTO (Compte Titres Ordinaire)',
    definition:
      "Compte d'investissement sans avantage fiscal mais sans contrainte (tous types d'actifs, tous marchés mondiaux). Les gains sont taxés à 30 % (flat tax).",
    example: 'CTO chez votre banque ou broker : permet d\'acheter Apple, Nvidia, ETF S&P 500, crypto-ETN, etc.',
    related: ['pea', 'flat-tax'],
    category: 'finance',
  },
  {
    slug: 'assurance-vie',
    term: 'Assurance-vie (AV)',
    definition:
      "Enveloppe fiscale et successorale française. Après 8 ans, les retraits bénéficient d'un abattement annuel (4 600 € seul, 9 200 € couple). Permet aussi de transmettre hors succession dans certaines limites.",
    example: 'AV ouverte en 2017, retrait en 2026 : 8 000 € de gains exonérés grâce à l\'abattement.',
    related: ['per-retraite', 'pea'],
    category: 'finance',
  },
  {
    slug: 'per-retraite',
    term: 'PER (Plan d\'Épargne Retraite)',
    definition:
      "Enveloppe fiscale dédiée à la préparation de la retraite. Versements déductibles du revenu imposable, capital bloqué jusqu'à la retraite (sauf cas de déblocage anticipé).",
    example: 'Versement de 5 000 € sur PER avec TMI 30 % : économie d\'impôt immédiate de 1 500 €. Capital récupéré à 67 ans.',
    related: ['assurance-vie'],
    category: 'finance',
  },
  {
    slug: 'flat-tax',
    term: 'Flat tax (PFU)',
    definition:
      "Prélèvement Forfaitaire Unique français de 30 % sur les revenus du capital (12,8 % impôt + 17,2 % prélèvements sociaux). S'applique par défaut hors enveloppes spécifiques (PEA, AV).",
    example: 'Plus-value de 1 000 € sur CTO : 300 € de flat tax = 700 € net.',
    related: ['pea', 'cto', 'plus-value'],
    category: 'finance',
  },
  {
    slug: 'ifu',
    term: 'IFU (Imprimé Fiscal Unique)',
    definition:
      "Document récapitulatif fourni chaque année par votre broker ou banque (avant fin février) listant tous vos revenus de capitaux mobiliers de l'année précédente. Sert à remplir votre déclaration de revenus.",
    example: 'IFU 2026 reçu en février : récapitule dividendes encaissés et plus/moins-values réalisées en 2025.',
    related: ['flat-tax', 'plus-value'],
    category: 'finance',
  },
  {
    slug: 'fifo',
    term: 'FIFO (First In, First Out)',
    definition:
      "Méthode de calcul des plus-values utilisée par défaut en France : on considère que les premières actions achetées sont les premières vendues. Détermine le prix de revient en cas de ventes partielles.",
    example: '10 actions à 50 € puis 10 à 100 €. Vente de 10 actions à 120 € → FIFO : prix de revient 50 € → plus-value 70 €/action.',
    related: ['lifo', 'plus-value'],
    category: 'finance',
  },
  {
    slug: 'lifo',
    term: 'LIFO (Last In, First Out)',
    definition:
      "Méthode alternative : on considère que les dernières actions achetées sont les premières vendues. Non utilisée en France pour la fiscalité, mais courante en comptabilité d'entreprise.",
    example: '10 actions à 50 € puis 10 à 100 €. Vente de 10 actions à 120 € → LIFO : prix de revient 100 € → plus-value 20 €/action.',
    related: ['fifo'],
    category: 'finance',
  },
  {
    slug: 'coupon',
    term: 'Coupon',
    definition:
      "Intérêt périodique versé par une obligation à son détenteur. Exprimé en pourcentage du nominal et payé en général chaque semestre ou chaque année jusqu'à l'échéance.",
    example: 'Obligation 1 000 € nominal, coupon 4 % annuel = 40 €/an versés au détenteur.',
    related: ['obligation', 'ytm', 'duration'],
    category: 'finance',
  },
  {
    slug: 'ytm',
    term: 'YTM (Yield to Maturity / rendement à l\'échéance)',
    definition:
      "Rendement annualisé attendu si vous détenez une obligation jusqu'à son remboursement, en tenant compte du prix d'achat, des coupons et du remboursement final.",
    example: 'Obligation cotée 95 € (nominal 100 €), coupon 3 %, échéance 5 ans → YTM ≈ 4,1 %.',
    related: ['obligation', 'coupon', 'duration'],
    category: 'finance',
  },
  {
    slug: 'duration',
    term: 'Duration',
    definition:
      "Mesure de la sensibilité du prix d'une obligation aux variations de taux d'intérêt, exprimée en années. Plus la duration est élevée, plus le prix bouge fort quand les taux varient.",
    example: 'Obligation duration 7 ans : si les taux montent de 1 %, son prix baisse d\'environ 7 %.',
    related: ['obligation', 'ytm', 'risque-de-marche'],
    category: 'finance',
  },
  {
    slug: 'ter',
    term: 'TER (Total Expense Ratio)',
    definition:
      "Frais annuels totaux d'un fonds (ETF, OPCVM…), exprimés en pourcentage des encours. Inclut frais de gestion, dépositaire, audit. Prélevés en continu sur la valeur du fonds.",
    example: 'ETF S&P 500 TER 0,07 % vs OPCVM actif TER 1,8 % → 1,73 % d\'écart annuel composé sur 20 ans = écart de performance énorme.',
    related: ['etf', 'opcvm'],
    category: 'finance',
  },
  {
    slug: 'opcvm',
    term: 'OPCVM (fonds collectif)',
    definition:
      "Organisme de Placement Collectif en Valeurs Mobilières. Fonds qui mutualise l'épargne de plusieurs investisseurs pour acheter un panier d'actifs. Inclut SICAV et FCP.",
    example: 'Achat d\'1 part d\'OPCVM actions Europe = exposition à 80-200 entreprises européennes en une transaction.',
    related: ['sicav', 'etf', 'ter'],
    category: 'finance',
  },
  {
    slug: 'sicav',
    term: 'SICAV (Société d\'Investissement à Capital Variable)',
    definition:
      "Forme juridique d'OPCVM organisée en société anonyme. L'investisseur achète des actions de la SICAV. Les ETF sont une forme de SICAV cotée en continu.",
    example: 'SICAV Carmignac Patrimoine, SICAV Amundi Index MSCI World, etc. Liste consultable chez votre banque.',
    related: ['opcvm', 'etf'],
    category: 'finance',
  },

  // Métriques de risque & performance
  {
    slug: 'sharpe',
    term: 'Ratio de Sharpe',
    definition:
      "Mesure de la performance ajustée du risque : (rendement − taux sans risque) ÷ volatilité. Plus le ratio est élevé, plus le rendement est obtenu efficacement par unité de risque pris.",
    example: 'Sharpe 1,5 = très bon. Sharpe 0,5 = médiocre. Sharpe < 0 = on aurait mieux fait de laisser sur livret A.',
    related: ['sortino', 'volatilite'],
    category: 'risque',
  },
  {
    slug: 'sortino',
    term: 'Ratio de Sortino',
    definition:
      "Variante du Sharpe qui ne pénalise que la volatilité à la baisse (downside deviation). Plus pertinent pour évaluer une stratégie : on ne se plaint pas de la volatilité positive.",
    example: 'Stratégie avec Sortino 2,0 et Sharpe 1,2 → la « volatilité » de la stratégie est principalement à la hausse, c\'est plutôt rassurant.',
    related: ['sharpe', 'drawdown'],
    category: 'risque',
  },
  {
    slug: 'calmar',
    term: 'Ratio de Calmar',
    definition:
      "Rendement annualisé divisé par le drawdown maximum sur la période. Mesure combien de gain on obtient pour chaque unité de perte temporaire subie.",
    example: 'Stratégie +18 %/an avec drawdown max −12 % → Calmar 1,5. Excellent pour qui supporte mal les baisses temporaires.',
    related: ['drawdown', 'sortino'],
    category: 'risque',
  },
  {
    slug: 'beta-financier',
    term: 'Beta (β)',
    definition:
      "Sensibilité d'un actif aux mouvements du marché de référence. β = 1 → bouge comme le marché. β = 1,5 → amplifie les mouvements de 50 %. β = 0 → indépendant.",
    example: 'Apple a un β proche de 1,2 vs S&P 500. Quand l\'indice fait +10 %, Apple tend à faire +12 %.',
    related: ['alpha-financier', 'correlation'],
    category: 'risque',
  },
  {
    slug: 'alpha-financier',
    term: 'Alpha (α)',
    definition:
      "Sur-performance d'un actif par rapport à ce que son beta laissait prévoir. α positif = le gérant a apporté de la valeur ; α négatif = il a détruit de la valeur par rapport au benchmark.",
    example: 'Fonds qui fait +12 % alors que son indice fait +10 % avec β = 1 → α = +2 % de surperformance attribuable au gérant.',
    related: ['beta-financier', 'rendement'],
    category: 'risque',
  },
  {
    slug: 'var',
    term: 'VaR (Value at Risk)',
    definition:
      "Perte maximale probable sur un horizon donné, à un niveau de confiance choisi. VaR 95 % à 1 jour de 200 € = on s'attend à ne pas perdre plus de 200 € sur 95 % des jours.",
    example: 'Portefeuille 10 000 €, VaR 95 % 1 jour = 250 €. Sur 100 jours, on pourrait dépasser cette perte ~5 fois.',
    related: ['cvar', 'drawdown'],
    category: 'risque',
  },
  {
    slug: 'cvar',
    term: 'CVaR (Conditional VaR / Expected Shortfall)',
    definition:
      "Perte moyenne attendue dans les 5 % des pires cas (au-delà de la VaR). Plus pessimiste que la VaR — capture l'épaisseur de la queue gauche de la distribution.",
    example: 'VaR 95 % = 250 €, mais CVaR 95 % = 600 € → quand ça dépasse la VaR, c\'est en moyenne 600 € de perte.',
    related: ['var', 'drawdown'],
    category: 'risque',
  },

  // Mécanique de trading & exécution
  {
    slug: 'ordre-marche',
    term: 'Ordre au marché',
    definition:
      "Instruction d'achat ou de vente exécutée immédiatement au meilleur prix disponible dans le carnet d'ordres. Garantie d'exécution rapide, pas garantie de prix.",
    example: 'Cours 100 €, carnet : 100,02 € à la vente. Ordre marché → exécuté instantanément à 100,02 €.',
    related: ['ordre-limite', 'carnet-ordres', 'slippage'],
    category: 'plateforme',
  },
  {
    slug: 'ordre-limite',
    term: 'Ordre à cours limité',
    definition:
      "Instruction d'achat ou de vente exécutable seulement si le marché atteint le prix défini, ou mieux. Garantie de prix, pas garantie d'exécution.",
    example: 'Achat limite à 95 € sur action cotée 100 € → ordre attend que le cours descende à 95 €. Si cela n\'arrive pas, l\'ordre ne s\'exécute jamais.',
    related: ['ordre-marche', 'ordre-stop'],
    category: 'plateforme',
  },
  {
    slug: 'ordre-stop',
    term: 'Ordre stop (déclenchement)',
    definition:
      "Ordre dormant qui s'active automatiquement quand le cours franchit un seuil. Une fois déclenché, il devient ordre marché (stop) ou ordre limite (stop limit).",
    example: 'Position longue 100 €, ordre stop à 95 € → si le cours touche 95 €, vente automatique au prix de marché. Sert de stop-loss.',
    related: ['stop-loss', 'ordre-marche', 'ordre-limite'],
    category: 'plateforme',
  },
  {
    slug: 'gtc',
    term: 'GTC (Good Till Cancelled)',
    definition:
      "Modalité de validité d'un ordre : reste actif jusqu'à exécution ou annulation manuelle. Utile pour des ordres limites éloignés du cours actuel.",
    example: 'Ordre achat limite à 95 € en GTC : reste dans le carnet d\'ordres pendant des semaines/mois jusqu\'à atteindre le prix.',
    related: ['ordre-limite', 'ioc', 'fok'],
    category: 'plateforme',
  },
  {
    slug: 'ioc',
    term: 'IOC (Immediate or Cancel)',
    definition:
      "Modalité d'ordre : exécute immédiatement la quantité disponible au prix demandé, annule le reste. Évite de laisser un ordre partiel traîner dans le carnet.",
    example: 'Ordre IOC achat 1 000 actions à 100 € : 700 actions disponibles à ce prix → achat de 700, les 300 restantes sont annulées.',
    related: ['gtc', 'fok'],
    category: 'plateforme',
  },
  {
    slug: 'fok',
    term: 'FOK (Fill or Kill)',
    definition:
      "Modalité d'ordre : exécute la totalité immédiatement au prix demandé, ou annule entièrement. Tout ou rien — pas d'exécution partielle acceptée.",
    example: 'Ordre FOK achat 1 000 actions à 100 € : 700 disponibles → ordre annulé entièrement (pas d\'achat partiel).',
    related: ['gtc', 'ioc'],
    category: 'plateforme',
  },
  {
    slug: 'fill',
    term: 'Fill (exécution)',
    definition:
      "Confirmation qu'un ordre a été exécuté, totalement ou partiellement. Détaille la quantité exécutée, le prix moyen et l'horodatage.",
    example: 'Ordre achat 100 actions → fill de 60 à 100,02 € puis fill de 40 à 100,03 € → prix moyen pondéré 100,024 €.',
    related: ['ordre-marche', 'commission', 'slippage'],
    category: 'plateforme',
  },
  {
    slug: 'commission',
    term: 'Commission (frais de courtage)',
    definition:
      "Frais facturés par le broker à chaque transaction. Soit fixe (ex : 1 € par ordre), soit en pourcentage du notionnel (ex : 0,1 %), souvent avec un minimum.",
    example: 'Achat 5 000 € chez un broker à 0,1 % min 5 € : commission = 5 €. Chez un broker à 1 € fixe : commission = 1 €.',
    related: ['fill', 'spread', 'slippage'],
    category: 'plateforme',
  },
  {
    slug: 'spread',
    term: 'Spread (écart bid-ask)',
    definition:
      "Différence entre le meilleur prix vendeur (ask) et le meilleur prix acheteur (bid) dans le carnet. Coût implicite payé à chaque aller-retour.",
    example: 'Bid 99,98 / Ask 100,02 → spread 0,04 € soit 4 bps. Acheter puis revendre immédiatement coûte 0,04 €/action sans aucune variation de marché.',
    related: ['bid-ask', 'carnet-ordres', 'slippage'],
    category: 'plateforme',
  },
  {
    slug: 'slippage',
    term: 'Slippage (glissement)',
    definition:
      "Écart entre le prix attendu d'un ordre et son prix d'exécution réel. Important sur les ordres marché de grande taille ou les actifs peu liquides.",
    example: 'Ordre marché achat 50 000 actions sur titre liquide ~10k vol/jour : prix de mid 100 €, prix moyen exécuté 100,80 € → slippage 80 bps.',
    related: ['spread', 'liquidite', 'ordre-marche'],
    category: 'plateforme',
  },
  {
    slug: 'bid-ask',
    term: 'Bid / Ask',
    definition:
      "Bid = meilleur prix proposé à l'achat dans le carnet. Ask = meilleur prix proposé à la vente. La différence est le spread, et le mid-price = (bid + ask) / 2.",
    example: 'Bid 99,98 / Ask 100,02 : pour acheter immédiatement, vous payez 100,02 ; pour vendre immédiatement, vous touchez 99,98.',
    related: ['spread', 'carnet-ordres'],
    category: 'plateforme',
  },
  {
    slug: 'carnet-ordres',
    term: 'Carnet d\'ordres',
    definition:
      "Liste ordonnée par prix de tous les ordres en attente sur un actif (achats à gauche, ventes à droite). Sa profondeur indique la liquidité disponible à chaque niveau de prix.",
    example: 'Carnet Apple : 50 000 actions à 100,00 € à l\'achat, 30 000 à 100,02 € à la vente. Acheter 60k au marché traverse plusieurs niveaux et fait monter le prix.',
    related: ['bid-ask', 'liquidite', 'spread'],
    category: 'plateforme',
  },

  // Conformité / réglementaire (gardés en plateforme)
  {
    slug: 'kyc',
    term: 'KYC (Know Your Customer)',
    definition:
      "Procédure d'identification du client imposée aux brokers et banques par la réglementation. Inclut justificatif d'identité, justificatif de domicile, et questionnaire de connaissance financière.",
    example: 'Ouverture compte broker : envoi pièce d\'identité + facture EDF + questionnaire 10 questions sur votre expérience financière. Validation 24-72 h.',
    related: ['aml'],
    category: 'plateforme',
  },
  {
    slug: 'aml',
    term: 'AML (Anti-Money Laundering)',
    definition:
      "Ensemble de règles et contrôles destinés à empêcher l'utilisation des marchés financiers pour blanchir de l'argent issu d'activités illicites. Justifie le KYC et le suivi des transactions.",
    example: 'Virement de 50 000 € vers un broker : déclenche souvent une demande de justificatif d\'origine des fonds (vente immobilière, héritage, etc.).',
    related: ['kyc'],
    category: 'plateforme',
  },

  // Stratégies / méthodologie
  {
    slug: 'walk-forward',
    term: 'Walk-forward (validation glissante)',
    definition:
      "Méthode de validation d'une stratégie : on l'optimise sur une période A, on la teste sur la période B suivante (jamais vue), puis on glisse les fenêtres. Évite l'over-fitting d'un backtest classique.",
    example: 'Optimisation 2018-2020 → test 2021. Optimisation 2019-2021 → test 2022. Etc. Performance moyenne sur les fenêtres de test = robustesse réelle.',
    related: ['backtest'],
    category: 'strategie',
  },
  {
    slug: 'backtest',
    term: 'Backtest',
    definition:
      "Simulation d'une stratégie sur des données historiques pour estimer sa performance passée. Indicatif uniquement — les performances passées ne préjugent pas des performances futures.",
    example: 'Stratégie momentum testée sur 2010-2024 : Sharpe 1,3, drawdown max −22 %. Indique une robustesse, mais pas une garantie pour 2025+.',
    related: ['walk-forward', 'sharpe', 'drawdown'],
    category: 'strategie',
  },
  {
    slug: 'dca',
    term: 'DCA (Dollar Cost Averaging)',
    definition:
      "Stratégie d'achat programmé à montant fixe et à fréquence régulière, indépendamment du cours. Lisse le prix de revient et évite le timing de marché.",
    example: '500 €/mois sur ETF World pendant 10 ans : achat plus d\'unités quand le marché baisse, moins quand il monte → prix moyen lissé.',
    related: ['buy-and-hold', 'allocation'],
    category: 'strategie',
  },
  {
    slug: 'buy-and-hold',
    term: 'Buy & Hold (acheter et conserver)',
    definition:
      "Stratégie passive consistant à acheter des actifs de qualité et les conserver à très long terme, en ignorant le bruit court terme. Inverse philosophique du trading actif.",
    example: 'Achat ETF S&P 500 en 2000, vente en 2025 : malgré 2 krachs majeurs, performance ~+450 % cumulée. Patience récompensée.',
    related: ['dca', 'horizon-investissement', 'mode-investment'],
    category: 'strategie',
  },
];

export function searchGlossary(query: string): GlossaryTerm[] {
  if (!query.trim()) return GLOSSARY_TERMS;
  const q = query.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return GLOSSARY_TERMS.filter((t) => {
    const haystack = `${t.term} ${t.definition} ${t.example ?? ''}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
    return haystack.includes(q);
  });
}

export function findGlossaryTerm(slug: string): GlossaryTerm | undefined {
  return GLOSSARY_TERMS.find((t) => t.slug === slug);
}
