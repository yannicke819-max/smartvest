/**
 * BLOC 2 — Enrichissement + gates secondaires v2 (ADR-005, synchro PR4).
 *
 * Changements vs PR3 :
 *   - Bloc2Input : candles1m/candles5m → candles + resolution (interface unifiée)
 *   - isSpreadTooWide : caps asset-class-aware (0.40% equity / 0.60% crypto)
 *   - RVOL : TOUJOURS désactivé par défaut (rvolEnabled=false) jusqu'à ETL baseline
 */

import { Injectable } from '@nestjs/common';
import type { GainersScoredCandidate } from '../domain/gainers-candidate.types';
import { CandidateRejectReason, SpreadProxySource } from '../domain/gainers-enums';
import {
  CandleOHLCV,
  SpreadProxyConfig,
  DEFAULT_SPREAD_PROXY_CONFIG,
  computeSpreadProxy,
  isSpreadTooWide,
} from './spread-proxy';
import { VolumeBaselineService } from './volume-baseline.service';

export interface Bloc2Input {
  candidate: GainersScoredCandidate;
  /**
   * Bougies dans l'ordre chronologique (la + récente en dernier).
   * Recommandé : 20+ bougies pour un p20 volume fiable.
   * null si non disponibles → STATIC_CAP_FALLBACK.
   */
  candles: CandleOHLCV[] | null;
  /**
   * Résolution des bougies. L'orchestrateur passe '1h' ou 'daily' pour
   * le spread proxy, '1m'/'5m' pour les triggers BLOC 3.
   */
  resolution: '1m' | '1h' | 'daily';
  /** Volume intraday cumulatif en USD (pour RVOL). null si non calculé. */
  intradayVolUsd: number | null;
}

export interface GainersBloc2Config {
  spreadProxy: SpreadProxyConfig;
  /** RVOL minimum. Défaut 1.5. */
  rvolMinThreshold: number;
  /** Désactivé par défaut jusqu'à ETL baseline peuplé. */
  rvolEnabled: boolean;
}

export const DEFAULT_BLOC2_CONFIG: GainersBloc2Config = {
  spreadProxy: DEFAULT_SPREAD_PROXY_CONFIG,
  rvolMinThreshold: 1.5,
  rvolEnabled: false,
};

@Injectable()
export class GainersBloc2Service {
  constructor(private readonly volumeBaseline: VolumeBaselineService) {}

  enrich(input: Bloc2Input, cfg: GainersBloc2Config = DEFAULT_BLOC2_CONFIG): GainersScoredCandidate {
    const { candidate, candles, resolution, intradayVolUsd } = input;

    if (candidate.decision !== 'ACCEPT') return candidate;

    const marketClass = candidate.raw.market;

    // — Spread proxy ——————————————————————————————————————————————————————————
    let spreadResult;
    if (candles && candles.length > 0) {
      spreadResult = computeSpreadProxy(candles, resolution, marketClass, cfg.spreadProxy);
    } else {
      const cap = marketClass === 'crypto'
        ? cfg.spreadProxy.spreadCapCryptoFraction
        : cfg.spreadProxy.spreadCapEquityFraction;
      spreadResult = { spreadFraction: cap, source: SpreadProxySource.STATIC_CAP_FALLBACK, usableCandles: 0 };
    }

    if (isSpreadTooWide(spreadResult, marketClass, cfg.spreadProxy)) {
      return {
        ...candidate,
        decision: 'REJECT',
        rejectReason: CandidateRejectReason.SPREAD_TOO_WIDE,
        spreadProxy: spreadResult.spreadFraction,
        spreadProxySource: spreadResult.source,
      };
    }

    // — RVOL ————————————————————————————————————————————————————————————————
    const rvolIntraday = intradayVolUsd !== null
      ? this.volumeBaseline.computeRvol(candidate.raw.symbol, candidate.raw.exchange, intradayVolUsd)
      : null;

    if (cfg.rvolEnabled && rvolIntraday !== null && rvolIntraday < cfg.rvolMinThreshold) {
      return {
        ...candidate,
        decision: 'REJECT',
        rejectReason: CandidateRejectReason.RVOL_INSUFFICIENT,
        spreadProxy: spreadResult.spreadFraction,
        spreadProxySource: spreadResult.source,
        rvolIntraday,
      };
    }

    return {
      ...candidate,
      spreadProxy: spreadResult.spreadFraction,
      spreadProxySource: spreadResult.source,
      rvolIntraday,
    };
  }

  enrichBatch(inputs: Bloc2Input[], cfg: GainersBloc2Config = DEFAULT_BLOC2_CONFIG): GainersScoredCandidate[] {
    return inputs.map((i) => this.enrich(i, cfg));
  }
}
