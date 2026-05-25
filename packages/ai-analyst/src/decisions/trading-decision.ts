/**
 * AXEES T1-#4 — No-Trade Intelligence semantic decisions.
 *
 * Aujourd'hui le scanner produit des chaînes type `reject_persistence`,
 * `reject_overextended`, `reject_cooldown`, ... qui sont consommées par les
 * analytics mais pas par les autres agents. Cette couche définit une enum
 * unifiée des verdicts possibles, alignée avec la vision AXEES :
 *
 *   "Le signal final ne devrait pas être seulement BUY/SELL/HOLD, mais
 *    aussi WAIT, QUARANTINE, REDUCE_SIZE, PAPER_ONLY, MARKET_UNSAFE,
 *    SIGNAL_DECAYED, LIQUIDITY_THIN, SPREAD_HIGH, REGIME_UNKNOWN."
 *
 * Bénéfice : permettre aux agents (V2 RM, OpportunityScout, OpenPositionRiskMonitor,
 * EarlyExitGuard, MechanicalTrading) de communiquer un verdict commun, et au
 * Debate Orchestrator futur (T1-#1) d'agréger ces verdicts en consensus.
 *
 * Back-compat : on ne casse RIEN. Cette layer est ADDITIVE — les strings DB
 * existantes restent. Helper `mapShadowDecisionToSemantic` traduit pour les
 * callers qui veulent le verdict sémantique unifié.
 */

/**
 * Tous les verdicts possibles d'un agent de trading.
 * Inspiré de la vision AXEES + mapping aux états réellement observés dans
 * SmartVest gainers aujourd'hui.
 */
export type TradingDecision =
  // Action effective
  | 'BUY'                 // ouverture LONG validée
  | 'SELL'                // ouverture SHORT validée
  | 'CLOSE'               // fermer position existante
  | 'HOLD'                // conserver, pas d'action

  // Non-trade explicite (pourquoi on n'agit pas)
  | 'WAIT'                // signal pas encore confirmé (persistence, micro-momentum)
  | 'COOLDOWN_ACTIVE'     // ré-entrée bloquée par cooldown
  | 'CAP_REACHED'         // maxOpenPositions atteint
  | 'CAPITAL_INSUFFICIENT'// pas assez de cash pour sizing min
  | 'DUPLICATE_SYMBOL'    // déjà une position ouverte sur ce symbol
  | 'SIGNAL_DECAYED'      // signal half-life expiré (T1-#2)

  // Sécurité données
  | 'STALE_PRICE'         // source prix unreliable (stale_/fallback_)
  | 'LIQUIDITY_THIN'      // volume/dollar-volume sous floor
  | 'SPREAD_HIGH'         // spread proxy > seuil
  | 'MARKET_CLOSED'       // session fermée (weekend, hors heures)
  | 'HOLIDAY'             // jour férié exchange

  // Décisions risque
  | 'MARKET_UNSAFE'       // régime panique/euphorie extrême, no new entries
  | 'CHASE_THE_TOP'       // candidat sur-étendu (changePct > plafond per-class)
  | 'REDUCE_SIZE'         // open autorisé mais sizing réduit
  | 'PAPER_ONLY'          // exécution simulation only, no real broker
  | 'QUARANTINE'          // stratégie/symbol en quarantaine (death-trap, drawdown)
  | 'KILL_SWITCH_ACTIVE'  // kill switch user-triggered ou auto

  // Régime / contexte
  | 'REGIME_UNKNOWN'      // detection failed, conservative skip
  | 'HORS_TRAJECTOIRE';   // PnL 7j négatif, mode défensif

/**
 * Contexte sémantique d'une décision.
 * Permet de remonter pourquoi + qui + métadonnées riches sans casser le typage.
 */
export interface DecisionContext {
  decision: TradingDecision;
  /** Raison courte humaine (max 200 chars). */
  reason: string;
  /** Qui a produit ce verdict : 'scanner_gainers' | 'gemini_v2_rm' | 'gemini_scout' | 'risk_monitor' | 'mechanical' | 'early_exit' | etc. */
  triggeredBy: string;
  /** Score confidence 0..1 si applicable (Gemini, p_win, etc.). */
  confidence?: number;
  /** Time-to-live du signal en ms (T1-#2 half-life). Undefined = pas de decay. */
  ttlMs?: number;
  /** Timestamp d'émission pour calculer signal age vs ttlMs. */
  emittedAt?: number;
  /** Métadonnées libres : persistence_score, path_eff, age, news_count, etc. */
  metadata?: Record<string, unknown>;
}

/**
 * Mapping des strings `decision` actuellement stockées en DB
 * (`gainers_user_shadow_signals.decision`) vers le verdict sémantique unifié.
 *
 * Garde une correspondance 1:1 sans changer le DB schema. Permet aux nouveaux
 * consumers (Debate Orchestrator, analytics future) de raisonner sur la
 * sémantique stable plutôt que sur les strings legacy.
 */
const SHADOW_DECISION_TO_SEMANTIC: Record<string, TradingDecision> = {
  // Accept = action
  accept: 'BUY',

  // Persistence / quality gates
  reject_persistence: 'WAIT',
  reject_path_eff: 'WAIT',
  reject_p_win: 'WAIT',
  reject_no_tf_data: 'REGIME_UNKNOWN',

  // Capacity / cap
  reject_budget_cap: 'CAP_REACHED',
  reject_cooldown: 'COOLDOWN_ACTIVE',
  reject_post_sl_cooldown: 'COOLDOWN_ACTIVE',

  // Risk gates
  reject_overextended: 'CHASE_THE_TOP',
  reject_volatile_regime: 'MARKET_UNSAFE',
  reject_stagflation_hedge_guard: 'MARKET_UNSAFE',
  reject_reentry_downtrend: 'QUARANTINE',
  reject_liquidity: 'LIQUIDITY_THIN',

  // Session / holiday
  reject_market_closed: 'MARKET_CLOSED',
  reject_signal_stale: 'SIGNAL_DECAYED',

  // Hour gates
  reject_hour_blacklisted: 'MARKET_UNSAFE',
  reject_hour_not_whitelisted: 'WAIT',

  // Catch-all
  reject_other: 'REGIME_UNKNOWN',
};

/**
 * Traduit une décision legacy (string scanner) en verdict sémantique.
 * Retourne 'REGIME_UNKNOWN' pour les decisions inconnues (safe fallback).
 */
export function mapShadowDecisionToSemantic(legacyDecision: string): TradingDecision {
  return SHADOW_DECISION_TO_SEMANTIC[legacyDecision] ?? 'REGIME_UNKNOWN';
}

/**
 * Catégorise un verdict comme "ACTIONABLE" (effectue une action trade) vs
 * "NO_TRADE" (skip explicite avec une raison sémantique).
 *
 * Utile pour les compteurs analytics : "% no-trade par catégorie", "ratio
 * actionable vs no-trade".
 */
export function isActionable(decision: TradingDecision): boolean {
  return decision === 'BUY' || decision === 'SELL' || decision === 'CLOSE' || decision === 'REDUCE_SIZE';
}

/**
 * Classes de no-trade pour grouping analytics.
 */
export type NoTradeClass = 'data_safety' | 'risk_governance' | 'wait_for_signal' | 'capacity' | 'regime' | 'unknown';

export function classifyNoTrade(decision: TradingDecision): NoTradeClass {
  if (isActionable(decision)) return 'unknown';  // ne devrait pas être appelé sur actionable
  switch (decision) {
    case 'STALE_PRICE': case 'LIQUIDITY_THIN': case 'SPREAD_HIGH': case 'MARKET_CLOSED': case 'HOLIDAY':
      return 'data_safety';
    case 'MARKET_UNSAFE': case 'CHASE_THE_TOP': case 'QUARANTINE': case 'KILL_SWITCH_ACTIVE': case 'HORS_TRAJECTOIRE': case 'PAPER_ONLY':
      return 'risk_governance';
    case 'WAIT': case 'SIGNAL_DECAYED':
      return 'wait_for_signal';
    case 'COOLDOWN_ACTIVE': case 'CAP_REACHED': case 'CAPITAL_INSUFFICIENT': case 'DUPLICATE_SYMBOL':
      return 'capacity';
    case 'REGIME_UNKNOWN':
      return 'regime';
    case 'HOLD':
      return 'wait_for_signal';
    default:
      return 'unknown';
  }
}
