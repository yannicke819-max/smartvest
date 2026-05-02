/**
 * BLOC 4 — Trailing engine : state machine + ratchet stop.
 *
 * Spec ADR-005 PR5 (locked, item #18) — naming corrigé : trailing_20 / trailing_50,
 * PAS "breakeven".
 *
 * Important : le TP_FULL ne ferme la position qu'en état OPEN. Une fois en
 * TRAILING_20 ou TRAILING_50, le TP cap est levé — on laisse courir les winners
 * sous protection trailing. Sans cette règle, T50 (activation ≥ +2×path_eff)
 * serait inatteignable car le TP equity (+1.5×path_eff) ferme avant.
 *
 * État OPEN :
 *   stop_price = sl_price initial (entry × (1 - sl_pct))
 *   on tick :
 *     - price ≤ stop_price → CLOSED (SL)
 *     - price ≥ tp_price   → CLOSED (TP_FULL)
 *     - gain ≥ +path_eff   → state = TRAILING_20
 *
 * État TRAILING_20 (lock 20% du MFE_gain) :
 *   stop_price = max(stop_price, entry × (1 + 0.20 × MFE_gain))
 *   on tick :
 *     - price ≤ stop_price → CLOSED (TRAILING_20_HIT)
 *     - gain ≥ +2×path_eff → state = TRAILING_50  (TP cap levé)
 *
 * État TRAILING_50 (lock 50% du MFE_gain) :
 *   stop_price = max(stop_price, entry × (1 + 0.50 × MFE_gain))
 *   on tick :
 *     - price ≤ stop_price → CLOSED (TRAILING_50_HIT)
 *
 * Ratchet : stop_price ne descend JAMAIS (max() entre stop courant et calculé).
 * MFE_gain : (mfe - entry) / entry — never decreases.
 */

import { ExitReason, PositionState } from '../domain/gainers-enums';

export interface TrailingConfig {
  /** Fraction du MFE lockée en TRAILING_20 (défaut 0.20). */
  trailing20LockFraction: number;
  /** Fraction du MFE lockée en TRAILING_50 (défaut 0.50). */
  trailing50LockFraction: number;
}

export const DEFAULT_TRAILING_CONFIG: TrailingConfig = {
  trailing20LockFraction: 0.20,
  trailing50LockFraction: 0.50,
};

export interface PositionSnapshot {
  state: PositionState;
  entryPrice: number;
  /** path_eff en pourcentage (0.6 = 0.6% mouvement attendu). */
  pathEff: number;
  tpPrice: number;
  /** Stop initial (peut être surclassé par le trailing). */
  initialSlPrice: number;
  /** Stop courant — le max entre initialSl et trailing ratchet. */
  currentStopPrice: number;
  /** Max favorable excursion price observée. */
  mfePrice: number;
}

export interface TickInput {
  position: PositionSnapshot;
  currentPrice: number;
}

export interface TickResult {
  newState: PositionState;
  newStopPrice: number;
  newMfePrice: number;
  /** Si non-null : la position vient de fermer pour cette raison. */
  exitReason: ExitReason | null;
  /** Si non-null : transition d'état signalée (pour audit). */
  stateTransition: 'TO_TRAILING_20' | 'TO_TRAILING_50' | null;
  /**
   * Slippage du fill par rapport au niveau théorique (fraction décimale du
   * prix d'entrée). Non-null uniquement quand exitReason est set.
   * - TP_FULL  : (actual - tp_price) / entry — typiquement ≥ 0 (gap-up)
   * - SL       : (actual - initial_sl_price) / entry — typiquement ≤ 0
   * - TRAILING_*_HIT : (actual - trailing_stop) / entry — typiquement ≤ 0
   * Voir ADR-005 §11.3 — modèle de fill tick-based avec audit slippage.
   */
  slippagePct: number | null;
  /**
   * true si |slippagePct| > 1% — flag pour audit/review post-hoc.
   * Indique potentiel tick corrompu, halt de marché, ou gap massif.
   */
  anomalousFill: boolean;
}

/**
 * Applique un tick prix sur une position et retourne le nouvel état,
 * le stop ratcheté, le MFE mis à jour, et éventuellement l'exit reason.
 *
 * Ordre de check :
 *   1. SL/trailing hit (priorité max — protège le capital)
 *   2. TP hit
 *   3. State upgrade (TRAILING_20 ou TRAILING_50)
 *   4. Ratchet stop selon état courant
 */
export function applyTick(
  input: TickInput,
  cfg: TrailingConfig = DEFAULT_TRAILING_CONFIG,
): TickResult {
  const { position, currentPrice } = input;
  const { state, entryPrice, pathEff, tpPrice, currentStopPrice, mfePrice } = position;

  if (state === PositionState.CLOSED) {
    return {
      newState: PositionState.CLOSED,
      newStopPrice: currentStopPrice,
      newMfePrice: mfePrice,
      exitReason: null,
      stateTransition: null,
      slippagePct: null,
      anomalousFill: false,
    };
  }

  const newMfePrice = Math.max(mfePrice, currentPrice);
  // gainPct = (price - entry) / entry, exprimé en %
  const gainPct = ((currentPrice - entryPrice) / entryPrice) * 100;
  const mfeGainPct = ((newMfePrice - entryPrice) / entryPrice) * 100;

  // 1. Stop hit ?
  if (currentPrice <= currentStopPrice) {
    const exitReason =
      state === PositionState.OPEN ? ExitReason.SL
      : state === PositionState.TRAILING_20 ? ExitReason.TRAILING_20_HIT
      : ExitReason.TRAILING_50_HIT;
    const slippage = (currentPrice - currentStopPrice) / entryPrice;
    return {
      newState: PositionState.CLOSED,
      newStopPrice: currentStopPrice,
      newMfePrice,
      exitReason,
      stateTransition: null,
      slippagePct: slippage,
      anomalousFill: Math.abs(slippage) > 0.01,
    };
  }

  // 2. TP hit ? (uniquement en OPEN — let winners run sous trailing)
  if (state === PositionState.OPEN && currentPrice >= tpPrice) {
    const slippage = (currentPrice - tpPrice) / entryPrice;
    return {
      newState: PositionState.CLOSED,
      newStopPrice: currentStopPrice,
      newMfePrice,
      exitReason: ExitReason.TP_FULL,
      stateTransition: null,
      slippagePct: slippage,
      anomalousFill: Math.abs(slippage) > 0.01,
    };
  }

  // 3. State upgrade — checks ordered most-progressed first
  let newState = state;
  let stateTransition: 'TO_TRAILING_20' | 'TO_TRAILING_50' | null = null;

  if (state !== PositionState.TRAILING_50 && gainPct >= 2 * pathEff) {
    newState = PositionState.TRAILING_50;
    stateTransition = 'TO_TRAILING_50';
  } else if (state === PositionState.OPEN && gainPct >= pathEff) {
    newState = PositionState.TRAILING_20;
    stateTransition = 'TO_TRAILING_20';
  }

  // 4. Ratchet stop — sequential ratchets ensure TRAILING_50 stop ≥ TRAILING_20 stop
  let newStopPrice = currentStopPrice;
  if (newState === PositionState.TRAILING_20 || newState === PositionState.TRAILING_50) {
    const lock20 = entryPrice * (1 + (cfg.trailing20LockFraction * mfeGainPct) / 100);
    newStopPrice = Math.max(newStopPrice, lock20);
  }
  if (newState === PositionState.TRAILING_50) {
    const lock50 = entryPrice * (1 + (cfg.trailing50LockFraction * mfeGainPct) / 100);
    newStopPrice = Math.max(newStopPrice, lock50);
  }

  return {
    newState,
    newStopPrice,
    newMfePrice,
    exitReason: null,
    stateTransition,
    slippagePct: null,
    anomalousFill: false,
  };
}

/**
 * Applique une séquence de ticks (backtest / replay).
 * Retourne le snapshot final + la liste des transitions.
 */
export function replayTicks(
  initial: PositionSnapshot,
  prices: number[],
  cfg: TrailingConfig = DEFAULT_TRAILING_CONFIG,
): {
  finalSnapshot: PositionSnapshot;
  exitReason: ExitReason | null;
  exitPrice: number | null;
  exitSlippagePct: number | null;
  exitAnomalousFill: boolean;
  transitions: Array<{ index: number; transition: 'TO_TRAILING_20' | 'TO_TRAILING_50' }>;
} {
  let snap = { ...initial };
  const transitions: Array<{ index: number; transition: 'TO_TRAILING_20' | 'TO_TRAILING_50' }> = [];
  let exitReason: ExitReason | null = null;
  let exitPrice: number | null = null;
  let exitSlippagePct: number | null = null;
  let exitAnomalousFill = false;

  for (let i = 0; i < prices.length; i++) {
    const r = applyTick({ position: snap, currentPrice: prices[i] }, cfg);
    if (r.stateTransition) transitions.push({ index: i, transition: r.stateTransition });
    snap = {
      ...snap,
      state: r.newState,
      currentStopPrice: r.newStopPrice,
      mfePrice: r.newMfePrice,
    };
    if (r.exitReason) {
      exitReason = r.exitReason;
      exitPrice = prices[i];
      exitSlippagePct = r.slippagePct;
      exitAnomalousFill = r.anomalousFill;
      break;
    }
  }

  return { finalSnapshot: snap, exitReason, exitPrice, exitSlippagePct, exitAnomalousFill, transitions };
}
