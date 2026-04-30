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
