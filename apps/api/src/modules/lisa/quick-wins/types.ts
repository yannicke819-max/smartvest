/**
 * Phase 5 N1 PR-1 — Quick Wins pipeline shared types.
 *
 * Cascade ordre : QW#1 → QW#6 → QW#11 → QW#17 → QW#18.
 * Chaque QW retourne un QwTrace. La pipeline aggrège en QwResult.
 *
 * Asset classes attendues (valeurs granulaires Lisa déjà en base) :
 *   - 'crypto_major' / 'crypto_alt'
 *   - 'us_equity_large' / 'us_equity_small_mid'
 *   - 'eu_equity'
 *   - 'asia_equity'
 */

export type QwId = 'QW_1' | 'QW_6' | 'QW_11' | 'QW_17' | 'QW_18';

export type QwDecision = 'pass' | 'block' | 'modify';

export interface QwSignal {
  symbol: string;
  assetClass: string;
  /** ISO 8601 string. Si absent côté caller : new Date().toISOString(). */
  timestamp: string;
  /** Score composite (conviction / persistence / autre). null si non applicable. */
  score?: number | null;
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
