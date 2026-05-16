/**
 * PR-2 v2 — résolution TP/SL avec priorité matrice → ATR → floor.
 *
 * Pure helper sans I/O pour tester la chaîne de priorité sans dépendre
 * du constructeur de MechanicalTradingService.
 *
 * Unités : tout en POURCENT (3.0 = 3 %). Le caller convertit le décimal
 * matrice (0.030) en pct (3.0) avant d'appeler ce helper.
 */

export interface TpSlResolverInput {
  /** Override Lisa explicite (priorité 1). Null si non set. Pct (3.0 = 3 %). */
  targetTakeProfitPct: number | null | undefined;
  /** Décimal matrice converti en pct (0.030 → 3.0). Null si matrice absente / désactivée. */
  matrixTpPct: number | null;
  /** Magnitude matrice convertie en pct (-0.013 → 1.3). Null si matrice absente / désactivée. */
  matrixSlPct: number | null;
  /** ATR-derived stop pct (toujours fourni par deriveAtrStopPct). */
  atrStopPct: number;
  /** Multiplier directive Lisa appliqué au SL ATR-derived. */
  stopsMult: number;
  /** True si le portfolio est en HORS_TRAJECTOIRE → ignore matrice (logique micro-position). */
  degradedActive: boolean;
  /** ATR14 brut (pct) ; utilisé uniquement par le path degraded. */
  degradedAtr14Pct: number | null;
}

export interface TpSlResolverOutput {
  stopPct: number;
  tpPct: number;
  source: { stop: 'degraded_atr' | 'matrix' | 'atr_derived'; tp: 'lisa_override' | 'matrix' | 'atr_x2' };
}

/**
 * Priorité TP : (1) Lisa override → (2) matrice → (3) ATR×2 ≥ 4 % → floor 0.5
 * Priorité SL : (degraded ? 0.5×ATR14 : matrice → ATR×stopsMult) → floor 0.3
 */
export function resolveTpSlPcts(input: TpSlResolverInput): TpSlResolverOutput {
  let stopPct: number;
  let stopSource: TpSlResolverOutput['source']['stop'];

  if (input.degradedActive && input.degradedAtr14Pct != null) {
    stopPct = Math.max(input.degradedAtr14Pct * 0.5, 0.3);
    stopSource = 'degraded_atr';
  } else if (input.matrixSlPct != null) {
    stopPct = Math.max(input.matrixSlPct, 0.3);
    stopSource = 'matrix';
  } else {
    stopPct = Math.max(input.atrStopPct * input.stopsMult, 0.3);
    stopSource = 'atr_derived';
  }

  let tpRaw: number;
  let tpSource: TpSlResolverOutput['source']['tp'];

  if (typeof input.targetTakeProfitPct === 'number' && Number.isFinite(input.targetTakeProfitPct)) {
    tpRaw = input.targetTakeProfitPct;
    tpSource = 'lisa_override';
  } else if (input.matrixTpPct != null) {
    tpRaw = input.matrixTpPct;
    tpSource = 'matrix';
  } else {
    tpRaw = Math.max(input.atrStopPct * 2, 4);
    tpSource = 'atr_x2';
  }
  const tpPct = Math.max(tpRaw, 0.5);

  return { stopPct, tpPct, source: { stop: stopSource, tp: tpSource } };
}
