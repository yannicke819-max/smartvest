/**
 * Reverse Momentum — pure helper, no I/O.
 *
 * L'observation Kelly du 24/05 montre que TOUTES les classes ont WR 13-22 %.
 * Conséquence statistique : SHORTER ces mêmes candidats donnerait WR théorique
 * 78-87 %. Cette feature permet de tester ça en LIVE (no shadow).
 *
 * Modes (ENV REVERSE_MOMENTUM_MODE) :
 *   - 'long_only' (default) : behaviour actuel
 *   - 'short_only'          : ouvre SHORT au lieu de LONG (inverse SL/TP)
 *   - 'both'                : ouvre LONG + SHORT en parallèle, notional /2 chacun
 *                             (hedge naturel, mesure objective via le PnL réalisé)
 */

export type ReverseMomentumMode = 'long_only' | 'short_only' | 'both';

export interface ReverseMomentumConfig {
  mode: ReverseMomentumMode;
  shortSizeRatio: number; // ex 0.5 pour 'both' : 50 % LONG + 50 % SHORT
}

export const DEFAULT_REVERSE_MOMENTUM: ReverseMomentumConfig = {
  mode: 'long_only',
  shortSizeRatio: 0.5,
};

export function parseReverseMomentumConfig(env: {
  REVERSE_MOMENTUM_MODE?: string | undefined;
  REVERSE_MOMENTUM_SHORT_RATIO?: string | undefined;
}): ReverseMomentumConfig {
  const raw = (env.REVERSE_MOMENTUM_MODE ?? 'long_only').toLowerCase().trim();
  const mode: ReverseMomentumMode =
    raw === 'short_only' ? 'short_only' :
    raw === 'both' ? 'both' :
    'long_only';
  const ratioN = Number.parseFloat(env.REVERSE_MOMENTUM_SHORT_RATIO ?? '');
  const ratio = Number.isFinite(ratioN) && ratioN >= 0.1 && ratioN <= 0.9 ? ratioN : 0.5;
  return { mode, shortSizeRatio: ratio };
}

export interface OpenPlanItem {
  direction: 'long' | 'short';
  notionalMultiplier: number; // 1.0 = full notional, 0.5 = half
}

/**
 * Décide quelles position(s) ouvrir pour un candidat donné.
 *   - long_only : [{long, 1.0}]
 *   - short_only : [{short, 1.0}]
 *   - both : [{long, 0.5}, {short, 0.5}] (configurable via shortSizeRatio)
 */
export function planOpens(cfg: ReverseMomentumConfig): OpenPlanItem[] {
  switch (cfg.mode) {
    case 'short_only':
      return [{ direction: 'short', notionalMultiplier: 1.0 }];
    case 'both':
      return [
        { direction: 'long', notionalMultiplier: 1.0 - cfg.shortSizeRatio },
        { direction: 'short', notionalMultiplier: cfg.shortSizeRatio },
      ];
    case 'long_only':
    default:
      return [{ direction: 'long', notionalMultiplier: 1.0 }];
  }
}

/**
 * Compute stop/TP prices in function of direction.
 *   LONG  : SL = entry × (1 - sl%) , TP = entry × (1 + tp%)
 *   SHORT : SL = entry × (1 + sl%) , TP = entry × (1 - tp%)
 */
export function computeSlTpForDirection(
  entry: number,
  slPct: number,
  tpPct: number,
  direction: 'long' | 'short',
): { stopLoss: number; takeProfit: number } {
  if (direction === 'long') {
    return {
      stopLoss: entry * (1 - slPct / 100),
      takeProfit: entry * (1 + tpPct / 100),
    };
  }
  return {
    stopLoss: entry * (1 + slPct / 100),
    takeProfit: entry * (1 - tpPct / 100),
  };
}
