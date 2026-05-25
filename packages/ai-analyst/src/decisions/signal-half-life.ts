/**
 * AXEES T1-#2 — Signal Half-Life metadata.
 *
 * Aujourd'hui un signal scanner (ex: "BUY NANO.PA at 0.85 momentum") est traité
 * comme intemporel : si le mécanique le voit 3 minutes plus tard, il l'exécute
 * comme s'il venait d'être émis. Sur du scalping 1m, c'est mortel — le momentum
 * a déjà épuisé sa première vague.
 *
 * Vision AXEES :
 *
 *   "Chaque signal doit porter sa propre demi-vie. Un breakout 1m vaut 30s,
 *    un setup swing 4h vaut 2h. Si le temps écoulé > half-life, le signal
 *    est décay : confidence × decayFactor, ou rejeté si decayFactor < 0.3."
 *
 * Cette couche définit :
 *   - SignalEnvelope : DecisionContext enrichi de TTL et emit-timestamp
 *   - isSignalFresh / signalDecayFactor : helpers de décision en aval
 *   - HALF_LIFE_PRESETS : valeurs typées par stratégie / horizon
 *
 * Back-compat : ADDITIVE. Les agents qui n'émettent pas de ttlMs sont
 * considérés "fresh forever" (legacy behavior, no regression).
 */

import type { DecisionContext, TradingDecision } from './trading-decision';

/**
 * Presets de half-life en millisecondes, calibrés par horizon de stratégie.
 *
 * - SCALP_1M : breakout 1min crypto/gainers — décay rapide (45s)
 * - INTRADAY_5M : top-gainers persistence multi-TF — décay moyen (3min)
 * - INTRADAY_15M : Lisa cycle standard / harvest mode — décay confortable (10min)
 * - SWING_1H : Lisa investment / mechanical guard — décay long (45min)
 * - SWING_4H : thèses narrative / rebound-tp — décay très long (3h)
 * - DAILY : analyse macro / régime — décay 24h
 *
 * Règle empirique : half-life ≈ 75% du cycle de réévaluation du caller.
 * Au-delà de half-life, le signal vaut < 0.5 (linear decay).
 */
export const HALF_LIFE_PRESETS = {
  SCALP_1M: 45_000,
  INTRADAY_5M: 180_000,
  INTRADAY_15M: 600_000,
  SWING_1H: 2_700_000,
  SWING_4H: 10_800_000,
  DAILY: 86_400_000,
} as const;

export type HalfLifePreset = keyof typeof HALF_LIFE_PRESETS;

/**
 * Enveloppe sémantique d'un signal trading, avec décay temporel.
 *
 * Permet à un consumer aval (Debate Orchestrator, mécanique, audit) de
 * raisonner sur la fraicheur d'un signal sans avoir à connaitre la stratégie
 * émettrice.
 */
export interface SignalEnvelope {
  context: DecisionContext;
  /** Half-life en ms — au-delà, decayFactor < 0.5. */
  halfLifeMs: number;
  /** Timestamp d'émission (epoch ms). */
  emittedAt: number;
  /**
   * TTL absolu en ms — au-delà, signal totalement rejeté (decayFactor=0).
   * Default = 3 × halfLifeMs (decay résiduel <= 0.125 = négligeable).
   */
  hardExpiryMs?: number;
}

/**
 * Construit une SignalEnvelope avec presets typés (DX friendly).
 */
export function buildSignal(
  decision: TradingDecision,
  reason: string,
  triggeredBy: string,
  preset: HalfLifePreset,
  opts: {
    confidence?: number;
    emittedAt?: number;
    metadata?: Record<string, unknown>;
    hardExpiryMs?: number;
  } = {},
): SignalEnvelope {
  const halfLifeMs = HALF_LIFE_PRESETS[preset];
  const emittedAt = opts.emittedAt ?? Date.now();
  const context: DecisionContext = {
    decision,
    reason,
    triggeredBy,
    ttlMs: halfLifeMs,
    emittedAt,
  };
  if (opts.confidence !== undefined) context.confidence = opts.confidence;
  if (opts.metadata !== undefined) context.metadata = opts.metadata;
  return {
    context,
    halfLifeMs,
    emittedAt,
    hardExpiryMs: opts.hardExpiryMs ?? halfLifeMs * 3,
  };
}

/**
 * Calcule le facteur de décay temporel d'un signal.
 *
 * Modèle : linear decay sur [0, hardExpiryMs] avec point d'inflexion à
 * halfLifeMs (decay = 0.5). Au-delà du hard expiry, decay = 0.
 *
 *   age = 0           → 1.0  (signal frais)
 *   age = halfLife/2  → 0.75 (signal encore fort)
 *   age = halfLife    → 0.5  (signal moyen — seuil de décision recommandé)
 *   age = 2×halfLife  → 0.25 (signal faible)
 *   age = 3×halfLife  → 0.0  (signal mort, à rejeter)
 */
export function signalDecayFactor(signal: SignalEnvelope, now: number = Date.now()): number {
  const age = now - signal.emittedAt;
  if (age <= 0) return 1.0;
  const hardExpiry = signal.hardExpiryMs ?? signal.halfLifeMs * 3;
  if (age >= hardExpiry) return 0;
  if (age <= signal.halfLifeMs) {
    return 1.0 - 0.5 * (age / signal.halfLifeMs);
  }
  const remaining = hardExpiry - age;
  const decayWindow = hardExpiry - signal.halfLifeMs;
  return 0.5 * (remaining / decayWindow);
}

/**
 * Verdict simple : le signal est-il encore exploitable ?
 * Seuil par défaut 0.5 (= half-life atteint) — caller peut être plus
 * strict (0.7 = très frais) ou plus laxiste (0.3 = dernier wagon).
 */
export function isSignalFresh(
  signal: SignalEnvelope,
  opts: { minDecayFactor?: number; now?: number } = {},
): boolean {
  const min = opts.minDecayFactor ?? 0.5;
  return signalDecayFactor(signal, opts.now) >= min;
}

/**
 * Confidence ajustée par le décay temporel.
 *
 * Utile quand un consumer compare plusieurs signaux concurrents :
 * un BUY confidence=0.8 émis il y a 30s vaut plus qu'un BUY
 * confidence=0.9 émis il y a 4 minutes sur un preset SCALP_1M.
 *
 * Retourne undefined si le signal n'a pas de confidence base.
 */
export function decayedConfidence(signal: SignalEnvelope, now: number = Date.now()): number | undefined {
  const base = signal.context.confidence;
  if (typeof base !== 'number') return undefined;
  return base * signalDecayFactor(signal, now);
}

/**
 * Age du signal en ms (helper pour logs / metrics).
 */
export function signalAgeMs(signal: SignalEnvelope, now: number = Date.now()): number {
  return Math.max(0, now - signal.emittedAt);
}
