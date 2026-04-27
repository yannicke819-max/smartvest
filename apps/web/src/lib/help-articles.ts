/**
 * Aide contextuelle — articles structurés (architecture P4 §4.4).
 *
 * 3 niveaux : tooltip (brief) → popover (full article) → manuel détaillé.
 *
 * Pour ajouter un article :
 *   1. Définir l'id (kebab-case stable, jamais renommer)
 *   2. Remplir les 5 champs minimum
 *   3. Référencer dans le composant <Help id="..." /> à côté du champ UI
 *
 * Priorité de couverture (15 champs critiques identifiés en audit P3) :
 *  - anti-consensus, max-leverage, max-drawdown-2d, auto-approbation,
 *    max-position-size, expires-at-mandat, kill-switch, mandatory-stop-loss,
 *    take-profit-absolu, working-capital-fixe, sweep-mode, credibility,
 *    composite-score, output-mode, lifecycle-state
 */

export interface HelpArticle {
  /** ID stable (kebab-case) */
  id: string;
  /** Titre court */
  title: string;
  /** Tooltip 1 phrase — affiché au hover sur le ? */
  brief: string;
  /** Article complet — affiché dans le popover sur clic */
  detailed: string;
  /** Impact concret avec exemple chiffré si possible */
  impact: string;
  /** Risque associé / piège à éviter */
  risk: string;
  /** Exemple d'usage typique */
  example?: string;
  /** Articles liés (autres ids) */
  related?: string[];
}

export const HELP_ARTICLES: Record<string, HelpArticle> = {
  'anti-consensus': {
    id: 'anti-consensus',
    title: 'Anti-consensus strength',
    brief:
      'Force Lisa à challenger le consensus de marché. 0 = suit consensus, 10 = maximum contrarian.',
    detailed:
      "Plus la valeur est haute, plus Lisa filtre les thèses qui suivent simplement le narratif dominant et privilégie les setups où le marché est mal positionné (sentiment extrême, funding négatif, options skew tendu). À 0, Lisa propose les mêmes thèses que la masse. À 10, elle exige une asymétrie marquée vs consensus.",
    impact:
      'Sur 30j de simulation, anti-consensus 7 vs anti-consensus 3 : -40 % de thèses générées mais +15 % de hit rate sur les survivants.',
    risk:
      "Trop élevé (≥ 8) → Lisa rejette aussi les setups directionnels valides en marché de tendance. Trop bas (≤ 2) → Lisa devient un trend-follower générique, edge faible.",
    example:
      'VIX 12 + sentiment +0.7 sur SPX + put/call ratio 0.6 = consensus bullish saturé. Avec anti-consensus 7, Lisa boostera un setup short conviction 6 plutôt qu\'un long conviction 7.',
    related: ['risk-tolerance', 'max-leverage'],
  },

  'max-leverage': {
    id: 'max-leverage',
    title: 'Levier maximum',
    brief:
      "Multiple maximum sur l'exposition. 1.0 = pas de levier, 2.0 = exposition double du capital.",
    detailed:
      "Lisa peut allouer jusqu'à ce multiple en notional total ouvert / capital. Le levier amplifie symétriquement gains et pertes. En simulation paper, c'est sans risque. En exécution réelle (à venir), un levier 2× sur un drawdown 10 % = -20 % sur le capital effectif.",
    impact:
      'Levier 1.5× + stop 2 % = perte réelle 3 % par trade losing. Sur 50 trades à 40 % win rate : EV négative si edge < 1.5×.',
    risk:
      "À combiner avec attention aux stops : un stop 1.5 % × levier 1.5 = perte effective 2.25 %. Slippage amplifié sur tickets fréquents (HARVEST scalping).",
    example:
      "Capital $10k, levier 1.5× → exposition max $15k. Lisa peut donc ouvrir 6 positions de 25 % chacune jusqu'à 150 % d'expo.",
    related: ['max-drawdown-2d', 'mandatory-stop-loss', 'take-profit-absolu'],
  },

  'max-drawdown-2d': {
    id: 'max-drawdown-2d',
    title: 'Drawdown maximum 2 jours (hard kill)',
    brief:
      'Si le portfolio perd plus que ce % en 2 jours glissants, le kill-switch s\'arme automatiquement.',
    detailed:
      "Garde-fou de protection capital niveau portefeuille (P4.1). Quand le drawdown peak-to-current sur 48h dépasse ce seuil, l'autopilot ferme TOUTES les positions ouvertes au marché et désactive l'autopilot jusqu'à réactivation manuelle.",
    impact:
      "Limite stricte = arrêt forcé du saignement. Trade-off : stops trop serrés = liquidations sur volatilité normale. Stops trop larges = exposition catastrophique avant déclenchement.",
    risk:
      "Une valeur < 5 % en mode HARVEST hyper-active risque de se déclencher sur volatilité intraday normale. Une valeur > 20 % laisse passer des pertes graves avant intervention.",
    example:
      'Réglage 12 % : portefeuille à 10k, on ferme tout si valeur passe sous 8800 sur 48h. Rapide en marché baissier extrême, raisonnable en régime normal.',
    related: ['kill-switch', 'max-leverage'],
  },

  'auto-approbation': {
    id: 'auto-approbation',
    title: 'Auto-approbation (mode autonome)',
    brief:
      'Lisa ouvre/ferme les positions sans confirmation manuelle. SIMULATION PAPER UNIQUEMENT.',
    detailed:
      "Quand activé, chaque proposition Lisa est auto-approuvée et exécutée immédiatement par l'agent mécanique. Pas de modal de validation. **Aucun ordre réel n'est jamais envoyé** vers un broker en l'état actuel — toutes les positions sont virtuelles. Mode pensé pour observer le comportement Lisa sans friction utilisateur.",
    impact:
      "Réactivité maximale (Lisa peut agir en < 60s sur un event). Permet de tester en aveugle la performance Lisa sans biais d'approbation manuelle. Coûts API LLM augmentent (cycles plus fréquents).",
    risk:
      "Si tu arrêtes de regarder, Lisa accumule des positions selon ses garde-fous (mandate + risk constraints). Le bouton 'Stop immédiat' reste toujours accessible. Durée limitée (max 24h) recommandée.",
    example:
      'Activation 6h avec durée → expire automatiquement à 16h27 ce jour. Tu reviens, tu vois les trades exécutés, tu peux désactiver à tout moment.',
    related: ['kill-switch', 'expires-at-mandat'],
  },

  'kill-switch': {
    id: 'kill-switch',
    title: 'Kill-switch',
    brief:
      'Arrêt immédiat de toute autonomie. Toujours accessible, jamais gaté par feature flag.',
    detailed:
      "Le kill-switch ferme TOUTES les positions ouvertes au marché et désactive l'autopilot. Il existe à plusieurs niveaux : global (utilisateur), par mandat (AutonomyMandate), par profil hyper-trading. Aucun niveau ne peut être désarmé silencieusement — chaque action écrit un événement audit hash-chaîné.",
    impact:
      "Garantit que tu peux toujours reprendre la main, même si Lisa est en cours d'exécution autonome ou si un mandat est actif. Action immédiate, pas de délai.",
    risk:
      "Une fois armé, la réactivation est explicite (pas automatique). Tu dois manuellement ré-autoriser l'autopilot ET le mandat correspondant.",
    example:
      "Tu observes un comportement Lisa anormal (boucles d'ouvertures sur même ticker). Clic kill-switch → 4 positions fermées en 3s, autopilot off, événement audit '[KILL_SWITCH] User triggered manual'.",
    related: ['auto-approbation', 'max-drawdown-2d'],
  },

  'expires-at-mandat': {
    id: 'expires-at-mandat',
    title: 'Date d\'expiration du mandat',
    brief:
      "Date au-delà de laquelle le mandat d'autonomie devient inactif. OBLIGATOIRE, max 1 an.",
    detailed:
      'Aucun mandat ne peut être permanent (CLAUDE.md §6). Après cette date, toute action autonome est refusée par le système même si le mandat est encore en statut "active". Une transition automatique vers "expired" est planifiée.',
    impact:
      "Force une revue périodique des limites. Évite l'oubli d'un mandat trop laxiste qui resterait actif indéfiniment.",
    risk:
      "Aujourd'hui, l'UI n'affiche pas de countdown clair (audit P2 §2.2 — gap identifié). Tu peux te retrouver avec un mandat expiré sans alerte. Vérifie manuellement la date jusqu'à correction.",
    example:
      'Création le 27/04/2026 → expire 27/10/2026. Si toujours actif fin septembre, prévoir révision : revoir caps, allowed asset classes, kill-switch state.',
    related: ['kill-switch', 'max-position-size'],
  },

  'max-position-size': {
    id: 'max-position-size',
    title: 'Taille max par position (%)',
    brief:
      'Pourcentage maximum du portfolio par position individuelle.',
    detailed:
      "Limite stricte appliquée par le risk-enforcer au moment de la génération des thèses Lisa. Si Lisa propose une allocation supérieure, elle est automatiquement réduite ou la thèse est droppée.",
    impact:
      "Diversification forcée. Avec max 10 % et capital $10k, aucune position ne peut dépasser $1k. Limite l'impact d'un crash idiosyncratique sur un ticker.",
    risk:
      "Trop bas (< 5 %) → sur-diversification, edge dilué, frais accumulés. Trop haut (> 30 %) → concentration excessive, drawdown amplifié sur un seul mauvais call.",
    example:
      'Portfolio $10k, max 26 % → Lisa peut ouvrir SLV à 25 % ($2.5k), refuse 30 % avec warning "Position exceeds max 26 %, dropped".',
    related: ['max-leverage', 'expires-at-mandat'],
  },

  'take-profit-absolu': {
    id: 'take-profit-absolu',
    title: 'Take-profit absolu (%)',
    brief:
      'Lisa ferme automatiquement la position dès que le P&L latent atteint ce seuil.',
    detailed:
      "Garantit la matérialisation des gains avant retournement. Différent du trailing stop : c'est un seuil dur, atteint = exit immédiat. Configurable en mode DAILY_HARVEST, default 2.5 % en hyper-active.",
    impact:
      "À 2.5 %, couvre 12× les coûts moyens d'un trade en simulation paper (frais + spread + slippage). Plus haut = laisse courir plus, mais expose au retournement.",
    risk:
      "Trop bas (< 1 %) → frais bouffent les gains, edge négatif. Trop haut (> 5 %) → Lisa rate les pics et ramène souvent à breakeven puis en perte.",
    example:
      'Position BTC long entry $77k, take-profit 2.5 % → exit auto à $78.9k (+$1.9k = +$76 sur position $2.5k). Sweep PER_TRADE → vault.',
    related: ['mandatory-stop-loss', 'sweep-mode'],
  },

  'sweep-mode': {
    id: 'sweep-mode',
    title: 'Mode sweep (DAILY_HARVEST)',
    brief:
      'Quand sécuriser les gains réalisés vers le vault non réinjectable.',
    detailed:
      "PER_TRADE = chaque close gagnant transfère immédiatement le profit dans le vault sécurisé. END_OF_DAY = on cumule sur la journée et on sweep en fin de session. Le vault n'est JAMAIS réinjecté dans le capital de trading — c'est la discipline structurelle du mode HARVEST.",
    impact:
      "PER_TRADE = discipline maximale, capital de trading reste fixe. END_OF_DAY = capital peut grandir intraday (Lisa peut prendre des positions plus grosses) mais risque de tout reperdre avant la fin.",
    risk:
      "PER_TRADE peut sweeper trop tôt sur des winners qui auraient pu courir si laissés ouverts. END_OF_DAY casse la promesse 'ce qui est gagné est gardé' si la session se retourne en fin de journée.",
    example:
      "PER_TRADE : BTC close +$7 → sweep immédiat. Lisa redémarre la journée avec capital de référence original. END_OF_DAY : BTC +$7, RTX +$3, SLV -$2 → sweep $8 en fin de session.",
    related: ['take-profit-absolu', 'working-capital-fixe'],
  },

  'credibility-pct': {
    id: 'credibility-pct',
    title: 'Credibility % (objectifs)',
    brief:
      "Probabilité simulée d'atteindre l'objectif. PAS une garantie de rendement.",
    detailed:
      "Score basé sur simulation Monte Carlo (10k trajectoires) avec volatilité historique du profil de risque déclaré et hypothèses de rendement par profil (conservative 4 %, balanced 7 %, growth 10 %, aggressive 14 %). Les performances passées ne préjugent pas des performances futures.",
    impact:
      "Score 80 % = dans 80 % des trajectoires simulées, l'objectif est atteint à la date prévue. Score 30 % = scénario tendu, révision recommandée (cible, horizon, versements ou profil de risque).",
    risk:
      "Le score est probabiliste, pas certain. Un cygne noir réel n'est pas modélisé. Ne JAMAIS lire 80 % comme 'garantie 8 chances sur 10' — c'est une mesure dans les hypothèses du modèle.",
    example:
      "Objectif 100k$ en 5 ans, profil balanced (7 % max), versement 800$/mois : Monte Carlo donne 60 % de credibility → tendu mais atteignable. Si tu vises 110k$ même cadre : 30 % → réviser.",
    related: ['risk-tolerance'],
  },
};

export function findHelpArticle(id: string): HelpArticle | undefined {
  return HELP_ARTICLES[id];
}
