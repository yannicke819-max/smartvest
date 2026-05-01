/**
 * BLOC 2 — Enrichissement + gates secondaires (ADR-005).
 *
 * Reçoit les candidats ACCEPT de BLOC 1 et ajoute :
 *   1. Spread proxy (médiane HL sur bougies récentes)
 *   2. RVOL intraday cumulatif (vol_open→now / baseline 20j)
 *   3. Gate SPREAD_TOO_WIDE si spreadFraction > spreadCapFraction (0.30%)
 *   4. Gate RVOL_INSUFFICIENT si rvolEnabled et RVOL < minRvol (désactivé par défaut)
 *
 * La gate univers (UniverseGuardService) est évaluée en dehors du hot path
 * (appelée au boot et via l'endpoint observability).
 */

import { Injectable } from '@nestjs/common';
import type {
  GainersScoredCandidate,
} from '../domain/gainers-candidate.types';
import { CandidateRejectReason, SpreadProxySource } from '../domain/gainers-enums';
import {
  CandleOHLCV,
  SpreadProxyConfig,
  DEFAULT_SPREAD_PROXY_CONFIG,
  computeSpreadProxy,
} from './spread-proxy';
import { VolumeBaselineService } from './volume-baseline.service';

export interface Bloc2Input {
  candidate: GainersScoredCandidate;
  /** Bougies 1m récentes (5 dernières min au moins). null si non disponibles. */
  candles1m: CandleOHLCV[] | null;
  /** Bougies 5m récentes (fallback equity). null si non disponibles. */
  candles5m: CandleOHLCV[] | null;
  /** Volume intraday cumulatif en USD (pour RVOL). null si non calculé en amont. */
  intradayVolUsd: number | null;
}

export interface GainersBloc2Config {
  spreadProxy: SpreadProxyConfig;
  /** RVOL minimum pour accepter le candidat. Défaut 1.5. */
  rvolMinThreshold: number;
  /**
   * Active la gate RVOL. Désactivé par défaut jusqu'à ce que les baselines
   * soient peuplées par le pipeline ETL.
   */
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

  /**
   * Enrichit un candidat ACCEPT BLOC 1 avec spread proxy + RVOL.
   * Retourne le candidat enrichi, potentiellement REJECT si gate échoue.
   */
  enrich(input: Bloc2Input, cfg: GainersBloc2Config = DEFAULT_BLOC2_CONFIG): GainersScoredCandidate {
    const { candidate, candles1m, candles5m, intradayVolUsd } = input;

    // Uniquement les candidats ACCEPT entrent en BLOC 2.
    if (candidate.decision !== 'ACCEPT') return candidate;

    // — Spread proxy ——————————————————————————————————————————————————————————
    let spreadResult;
    if (candles1m && candles1m.length > 0) {
      spreadResult = computeSpreadProxy(candles1m, '1m', cfg.spreadProxy);
    } else if (candles5m && candles5m.length > 0) {
      spreadResult = computeSpreadProxy(candles5m, '5m', cfg.spreadProxy);
    } else {
      spreadResult = {
        spreadFraction: cfg.spreadProxy.spreadCapFraction,
        source: SpreadProxySource.STATIC_CAP_FALLBACK,
        usableCandles: 0,
      };
    }

    if (spreadResult.spreadFraction > cfg.spreadProxy.spreadCapFraction) {
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

  /** Enrichit un batch de candidats. Préserve les REJECT de BLOC 1. */
  enrichBatch(inputs: Bloc2Input[], cfg: GainersBloc2Config = DEFAULT_BLOC2_CONFIG): GainersScoredCandidate[] {
    return inputs.map((i) => this.enrich(i, cfg));
  }
}
