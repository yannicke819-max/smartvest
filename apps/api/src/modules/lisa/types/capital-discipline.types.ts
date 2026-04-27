/**
 * CapitalDisciplineMode — axe orthogonal au DelegationMode.
 *
 * Contrôle COMMENT les gains sont matérialisés et sécurisés au niveau
 * portefeuille. Ne change PAS qui prend les décisions de trading
 * (DelegationMode), ni la cadence (OperatingTempo), ni le cas perso
 * (PersonalOverrideMode). Ajoute une couche de discipline au-dessus.
 *
 * Modes :
 *  - NONE             : comportement classique, profits restent dans le capital
 *  - DAILY_HARVEST    : sweep journalier, capital de travail fixe, reset quotidien
 *
 * Évolutions futures possibles (à NE PAS implémenter maintenant) :
 *  - WEEKLY_HARVEST   : sweep hebdomadaire
 *  - LOSS_FLOOR_LOCK  : lock sur perte plancher
 *  - MARTINGALE_GUARD : prévention escalade après perte
 */
export type CapitalDisciplineMode = 'NONE' | 'DAILY_HARVEST';

/**
 * État de la session journalière (machine d'état).
 *
 * Transitions :
 *
 *   IDLE ──(1ère ouverture)──► ACTIVE
 *   ACTIVE ──(realized_pnl ≥ 80% target)──► TARGET_NEAR
 *   ACTIVE ──(realized_pnl ≥ 100% target)──► TARGET_HIT
 *   TARGET_NEAR ──(realized_pnl ≥ 100% target)──► TARGET_HIT
 *   TARGET_HIT ──(stopTradingWhenTargetHit=true)──► PROFIT_SWEEP_PENDING
 *   PROFIT_SWEEP_PENDING ──(sweep done)──► PROFIT_SWEPT
 *   PROFIT_SWEPT ──(stopTradingWhenTargetHit=true)──► DAILY_LOCKED
 *   PROFIT_SWEPT ──(allowReentryAfterTargetHit=true)──► ACTIVE (reset partiel)
 *   ACTIVE ──(realized_pnl ≤ -maxLossPerDay)──► LOSS_LIMIT_HIT
 *   LOSS_LIMIT_HIT ──► DAILY_LOCKED (auto)
 *   ANY ──(sessionEndTime atteint)──► SESSION_CLOSED
 *
 * États terminaux pour la journée :
 *  - DAILY_LOCKED   : aucune nouvelle entrée jusqu'au reset 00:00
 *  - SESSION_CLOSED : journée close, attend prochain reset
 */
export type HarvestState =
  | 'IDLE'
  | 'ACTIVE'
  | 'TARGET_NEAR'
  | 'TARGET_HIT'
  | 'PROFIT_SWEEP_PENDING'
  | 'PROFIT_SWEPT'
  | 'DAILY_LOCKED'
  | 'LOSS_LIMIT_HIT'
  | 'SESSION_CLOSED';

/**
 * Mode de sweep des profits.
 *
 * - PER_TRADE  : chaque trade gagnant fermé déclenche un sweep immédiat.
 *                Cohérent avec la philosophie "matérialiser au plus tôt".
 *                Plus de coûts (transferts multiples) mais protection max.
 * - END_OF_DAY : tous les profits réalisés de la journée sweepés en bloc
 *                à sessionEndTime. Plus simple à comprendre, mais le
 *                portefeuille est vulnérable aux pertes de fin de journée
 *                qui rongeraient les gains.
 */
export type ProfitSweepMode = 'PER_TRADE' | 'END_OF_DAY';

/**
 * Configuration du mode DAILY_HARVEST.
 *
 * Stockée en JSONB dans `lisa_session_configs.daily_harvest_config`.
 * Schéma documenté dans la migration 0066.
 *
 * Règle métier : exactement UNE des deux cibles doit être renseignée
 * (montant OU pourcentage). Si les deux sont fournies, le pourcentage
 * prime. Si aucune, le mode est inactif (équivalent à NONE).
 */
export interface DailyHarvestConfig {
  /** Cible journalière en USD absolu. Mutuellement exclusif avec percent. */
  dailyTargetAmountUsd?: number | null;
  /** Cible journalière en % du working capital. Prime sur amount si les deux sont set. */
  dailyTargetPercent?: number | null;

  /** Capital de travail fixe (référence opérationnelle). Le moteur ne déploiera
   *  jamais plus que ce montant pour le trading intraday. */
  workingCapitalBaseUsd: number;

  /** Cap absolu de capital alloué au trading (défense supplémentaire). */
  maxCapitalAllocationUsd?: number;

  /** Mode de sweep : à chaque trade gagnant ou en fin de journée. */
  profitSweepMode: ProfitSweepMode;

  /** Si true : aucune nouvelle entrée après TARGET_HIT (état → DAILY_LOCKED). */
  stopTradingWhenTargetHit: boolean;

  /** Si true ET stopTradingWhenTargetHit=false : autorise re-rentrée après
   *  sweep. Mode "scalping continu" — à n'activer qu'avec un cooldown. */
  allowReentryAfterTargetHit: boolean;

  /** Perte journalière maximale en USD. Au-delà → LOSS_LIMIT_HIT → DAILY_LOCKED. */
  maxLossPerDayUsd?: number;

  /** Nombre maximum de trades par jour. Au-delà → DAILY_LOCKED. */
  maxTradesPerDay?: number;

  /** Whitelist de classes d'actifs autorisées pendant la session.
   *  Vide ou absent = toutes les classes du portfolio sont autorisées. */
  allowedInstruments?: string[];

  /** Heure de début de session, format "HH:MM" en timezone user.
   *  Le reset journalier se fait à cette heure. */
  sessionStartTime: string;

  /** Heure de fin de session, format "HH:MM". Au-delà → SESSION_CLOSED. */
  sessionEndTime: string;

  /** Timezone IANA. Default 'Europe/Paris'. */
  timezone: string;

  /** Si un sweep dépasse ce montant, requiert validation humaine
   *  (uniquement actif en mode HYBRID_SUGGESTIVE). */
  requiresHumanApprovalAboveUsd?: number;

  /** Cooldown en minutes après chaque close avant qu'une nouvelle entrée
   *  soit possible. Évite le scalping frénétique. */
  cooldownMinutesAfterClose: number;
}

/**
 * Représentation d'une session journalière (1 ligne table daily_trading_sessions).
 */
export interface DailyTradingSession {
  id: string;
  portfolioId: string;
  sessionDate: string;            // ISO date 'YYYY-MM-DD'
  sessionTimezone: string;
  sessionStartedAt: string;
  sessionClosedAt: string | null;

  workingCapitalStartUsd: string;
  dailyTargetAmountUsd: string | null;
  dailyTargetPercent: number | null;
  maxLossPerDayUsd: string | null;
  maxTradesPerDay: number | null;

  state: HarvestState;
  realizedPnlTodayUsd: string;
  securedPnlTodayUsd: string;
  unrealizedPnlNowUsd: string | null;
  tradesCount: number;
  winningTradesCount: number;
  losingTradesCount: number;

  lastStateTransitionAt: string;
  lastStateTransitionReason: string | null;

  createdAt: string;
  updatedAt: string;
}

/**
 * Représentation du vault (1 ligne table secured_profit_balance).
 */
export interface SecuredProfitBalance {
  portfolioId: string;
  totalSecuredUsd: string;
  sweepCount: number;
  firstSweepAt: string | null;
  lastSweepAt: string | null;
  largestSingleSweepUsd: string | null;
}

/**
 * Distance à l'objectif journalier (calculée à la volée pour UI/persona).
 */
export interface DailyHarvestProgress {
  state: HarvestState;
  targetAmountUsd: number;        // converti en absolu (depuis percent si besoin)
  realizedToday: number;
  securedToday: number;
  remainingToTarget: number;      // négatif si target dépassé
  progressPct: number;            // 0-100+
  tradesCount: number;
  tradesRemainingBeforeCap: number | null;
  lossRemainingBeforeLock: number | null;
  isLocked: boolean;              // true si DAILY_LOCKED, LOSS_LIMIT_HIT, SESSION_CLOSED
}

/**
 * Constants utilisés par les services.
 */
export const HARVEST_CONSTANTS = {
  /** Seuil de proximité du target → état TARGET_NEAR (en %). */
  TARGET_NEAR_THRESHOLD_PCT: 80,

  /** Sleep entre 2 vérifications du governor (ms). 60s aligné sur le cron mécanique. */
  GOVERNOR_TICK_MS: 60_000,

  /** Validation : daily_target_percent doit être entre 0 et 50%. Au-delà = config invalide. */
  MAX_DAILY_TARGET_PERCENT: 50,

  /** Validation : working_capital min en USD. Sous ce seuil le sweep n'a pas de sens. */
  MIN_WORKING_CAPITAL_USD: 100,
} as const;
