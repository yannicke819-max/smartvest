/**
 * Phase 5 N1 — Quick Wins pipeline shared types.
 *
 * Cascade ordre (PR-1 puis PR-3 puis QW#14a) :
 *   CircuitBreaker → QW_46 → QW_47 → QW_1 → QW_6 → QW_11 →
 *   QW_9 → QW_27 → QW_4 → QW_17 → QW_15 → QW_18 → QW_14A
 *
 * QW_3 (warmup asymétrique) et QW_45 (force-close pre-AH) ne sont PAS dans
 * la cascade : QW_3 s'applique sur fermeture SL, QW_45 est un cron interne.
 *
 * Asset classes attendues (valeurs granulaires Lisa déjà en base) :
 *   - 'crypto_major' / 'crypto_alt'
 *   - 'us_equity_large' / 'us_equity_small_mid'
 *   - 'eu_equity'
 *   - 'asia_equity'
 */

export type QwId =
  | 'QW_1'
  | 'QW_3'
  | 'QW_4'
  | 'QW_6'
  | 'QW_7'
  | 'QW_8'
  | 'QW_9'
  | 'QW_11'
  | 'QW_14A'
  | 'QW_15'
  | 'QW_17'
  | 'QW_18'
  | 'QW_27'
  | 'QW_45'
  | 'QW_46'
  | 'QW_47'
  | 'CIRCUIT_BREAKER'
  | 'TD_SUPERTREND_US'    // PR #345 — filtre TwelveData Supertrend US equity
  | 'TD_RSI_CRYPTO'       // PR #345 — filtre TwelveData RSI crypto overbought
  | 'TD_SUPERTREND_ASIA' // PR #360 — filtre TwelveData Supertrend asia equity 30m
  | 'TD_SUPERTREND_EU';  // PR #368 — filtre TwelveData Supertrend eu equity 30m

export type QwDecision = 'pass' | 'block' | 'modify';

export interface QwSignal {
  symbol: string;
  assetClass: string;
  /** ISO 8601 string. Si absent côté caller : new Date().toISOString(). */
  timestamp: string;
  /** Score composite (conviction / persistence / autre). null si non applicable. */
  score?: number | null;
  /** Path efficiency [0,1] si fourni par le caller. Null sinon → QWs path-based no-op. */
  pathEff?: number | null;
  /** Portfolio cible (pour QW#15 first-trade-of-day query Supabase). */
  portfolioId?: string | null;
}

export interface QwTrace {
  qwId: QwId;
  decision: QwDecision;
  reason: string;
  /** Pour modify : multiplier appliqué au sizing (1.0 = neutre). */
  multiplier?: number;
  /** Pour modify (QW_18) : suffixe exchange détecté. */
  exchange?: string;
  /** Détail libre pour debug. */
  details?: Record<string, unknown>;
}

export type QwResult =
  | { decision: 'pass'; sizingMultiplier: 1.0; modifications: []; qwTrace: QwTrace[] }
  | { decision: 'block'; blockedBy: QwId; reason: string; qwTrace: QwTrace[] }
  | {
      decision: 'modify';
      sizingMultiplier: number;
      modifications: string[];
      qwTrace: QwTrace[];
    };
