/**
 * LISA THRESHOLDS — Configuration centralisée des seuils Lisa.
 *
 * Source unique de vérité pour tous les seuils du système Lisa :
 *  - material-change-detector : event-driven triggers
 *  - mechanical-trading : trailing stops, take-profit, RSI
 *  - lisa-autopilot : rate limit, safety_net
 *
 * Mode hyper-trading (`hyper`) vs mode standard (`standard`) :
 *  - hyper : seuils plus serrés pour anticipation (capture micro-moves)
 *  - standard : seuils larges pour positions long-terme (évite bruit)
 *
 * Trade-offs documentés dans les commentaires de chaque seuil.
 *
 * RETEX 26/04 :
 *  - Seuils initiaux trop élevés → mode event-driven castré sur portefeuille
 *    vide, Lisa passive 3h+ sans cycle.
 *  - Recalibrage : VIX 0.5→0.3, FUNDING 0.3→0.2, NEWS 75→60, AGE 5→15.
 *  - Ajout REFERENCE_TICKERS pour scanner sans positions.
 *  - Ajout TAKE_PROFIT_ABSOLUTE pour matérialiser les gains à +2.5%.
 */

export type LisaMode = 'hyper' | 'standard';

export interface LisaThresholds {
  // ═══════════════════════════════════════════════════════════════════════
  // CADENCE (lisa-autopilot.service.ts)
  // ═══════════════════════════════════════════════════════════════════════

  /** Délai minimum entre 2 cycles Lisa (anti-spam si VIX vacille). Hard
   *  rule, jamais override. 3 min = ~$0.30 max coût API par 3 min. */
  rateLimitMin: number;

  /** Filet de garantie (configurable par UI 5-60 min) — force un cycle
   *  même si calme. Default 30 min. UI : autopilot_cycle_minutes. */
  safetyNetMinDefault: number;

  /** Mutex anti-hang : si un cycle hangs > N min, force release. */
  mutexMaxAgeMs: number;

  // ═══════════════════════════════════════════════════════════════════════
  // EVENT-DRIVEN TRIGGERS (material-change-detector.service.ts)
  // ═══════════════════════════════════════════════════════════════════════

  /** Variation absolue VIX pour trigger un cycle event-driven.
   *  hyper 0.3 (VIX 18.5 → 1.6%) — capte micro-shifts.
   *  standard 0.5 — évite le bruit. */
  vixDeltaThreshold: number;

  /** Variation % DXY. 0.3% = ~30bps, signal macro fort. */
  dxyDeltaPct: number;

  /** Variation % d'une position tenue. 0.5% = bruit intraday filtré. */
  priceDeltaPct: number;

  /** Variation % d'un ticker de référence (SPY, BTC, etc.). Légèrement
   *  plus strict que positions tenues (0.6%) car ces tickers ultra-liquides
   *  bougent plus souvent. */
  referenceDeltaPct: number;

  /** Variation funding annualisé crypto (BTC perp). 0.2%/an = shift
   *  positionnement notable, anticipation squeeze. */
  fundingDeltaPct: number;

  /** Variation drawdown portefeuille (points %). 0.5pt = $50 sur $10k. */
  drawdownDeltaPt: number;

  /** Score min pour qu'une news soit considérée comme catalyst.
   *  hyper 60 (capte convergence cross-source).
   *  standard 75 (sélectif). */
  newsFreshMinScore: number;

  /** Âge max de la news en minutes pour être considérée fresh. */
  newsFreshMaxAgeMin: number;

  // ═══════════════════════════════════════════════════════════════════════
  // MECHANICAL TRADING — TRAILING & TAKE-PROFIT (mechanical-trading.service.ts)
  // ═══════════════════════════════════════════════════════════════════════

  /** P&L latent à partir duquel le trailing stop bouge à breakeven.
   *  hyper 0.8% — protection précoce.
   *  standard 1.5% — laisse respirer. */
  trailingBreakevenPnlPct: number;

  /** P&L latent à partir duquel le trailing lock à +0.5% du entry.
   *  hyper 1.5% — verrouille les gains tôt.
   *  standard 3% — laisse courir. */
  trailingLockPnlPct: number;

  /** P&L latent à partir duquel le trailing utilise -1× ATR du prix actuel.
   *  hyper 3% — stop dynamique précoce.
   *  standard 5% — pour gros mouvements. */
  trailingAtrPnlPct: number;

  /** TAKE-PROFIT ABSOLU — ferme TOUT si P&L atteint ce niveau. Garantit
   *  matérialisation des gains avant qu'ils s'évaporent.
   *  hyper 2.5% — couvre largement les coûts ~0.2% (×12 ratio).
   *  standard 4% — objectifs plus ambitieux. */
  takeProfitAbsolutePct: number;

  /** RSI overbought : si LONG + RSI > X + P&L positif → take profit.
   *  hyper 70 — anticipation reversal.
   *  standard 80 — confirmation extrême. */
  rsiOverbought: number;

  /** RSI oversold : si SHORT + RSI < X + P&L positif → take profit.
   *  hyper 30 — anticipation reversal.
   *  standard 20 — confirmation extrême. */
  rsiOversold: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// MODES
// ═══════════════════════════════════════════════════════════════════════════

export const LISA_THRESHOLDS_HYPER: LisaThresholds = {
  // Cadence
  rateLimitMin: 3,
  safetyNetMinDefault: 30,
  mutexMaxAgeMs: 5 * 60_000,

  // Event-driven (hyper-trading anticipatif — calibré 26/04)
  vixDeltaThreshold: 0.3,
  dxyDeltaPct: 0.3,
  priceDeltaPct: 0.5,
  referenceDeltaPct: 0.6,
  fundingDeltaPct: 0.4,  // 0.2→0.4 (26/04 soir) : evite cascade ETH funding triggers
  drawdownDeltaPt: 0.5,
  newsFreshMinScore: 60,
  newsFreshMaxAgeMin: 15,

  // Mechanical (anticipation maximale)
  trailingBreakevenPnlPct: 0.8,
  trailingLockPnlPct: 1.5,
  trailingAtrPnlPct: 3,
  takeProfitAbsolutePct: 2.5,
  rsiOverbought: 70,
  rsiOversold: 30,
};

export const LISA_THRESHOLDS_STANDARD: LisaThresholds = {
  // Cadence
  rateLimitMin: 3,
  safetyNetMinDefault: 60,
  mutexMaxAgeMs: 5 * 60_000,

  // Event-driven (large pour positions long-terme)
  vixDeltaThreshold: 0.5,
  dxyDeltaPct: 0.5,
  priceDeltaPct: 1.0,
  referenceDeltaPct: 1.0,
  fundingDeltaPct: 0.4,
  drawdownDeltaPt: 1.0,
  newsFreshMinScore: 75,
  newsFreshMaxAgeMin: 30,

  // Mechanical (laisse respirer)
  trailingBreakevenPnlPct: 1.5,
  trailingLockPnlPct: 3,
  trailingAtrPnlPct: 5,
  takeProfitAbsolutePct: 4,
  rsiOverbought: 80,
  rsiOversold: 20,
};

/**
 * Récupère les seuils selon le profile de session.
 * - hyper_active → LISA_THRESHOLDS_HYPER
 * - autres profiles → LISA_THRESHOLDS_STANDARD
 */
export function getLisaThresholds(mode: LisaMode): LisaThresholds {
  return mode === 'hyper' ? LISA_THRESHOLDS_HYPER : LISA_THRESHOLDS_STANDARD;
}

/**
 * Tickers de référence scannés MÊME quand 0 positions tenues.
 * Évite la castration du mode event-driven sur portefeuille vide.
 */
export const REFERENCE_TICKERS = [
  'SPY',   // S&P 500 — equity benchmark
  'QQQ',   // Nasdaq 100 — tech benchmark
  'IWM',   // Russell 2000 — small cap
  'BTC',   // Bitcoin — crypto reference
  'ETH',   // Ethereum — alt crypto reference
  'GLD',   // Gold ETF — précieux + de-dollarization
  'TLT',   // 20Y bonds — taux long terme
  'HYG',   // High-yield credit — risk-on/off proxy
] as const;
