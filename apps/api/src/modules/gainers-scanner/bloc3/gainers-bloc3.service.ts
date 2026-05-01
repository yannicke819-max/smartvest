/**
 * BLOC 3 — Évaluation des triggers d'entrée (ADR-005).
 *
 * Ordre d'évaluation : PULLBACK_HL_FIBO → VWAP_RECLAIM → NO_ENTRY_TRIGGER.
 * Le premier trigger qui matche est retenu ; les deux ne sont jamais émis simultanément.
 *
 * Ce service est pur-fonction côté logique métier (pas d'I/O) ; les données
 * (candles, VWAP, baselines) sont fournies par l'orchestrateur externe.
 */

import { Injectable } from '@nestjs/common';
import type { GainersScoredCandidate } from '../domain/gainers-candidate.types';
import { CandidateRejectReason } from '../domain/gainers-enums';
import type { CandleOHLCV } from '../bloc2/spread-proxy';
import { computeVwap } from './vwap';
import { evaluatePullbackHL, DEFAULT_PULLBACK_HL_CONFIG, PullbackHLConfig } from './pullback-hl';
import { evaluateVwapReclaim, DEFAULT_VWAP_RECLAIM_CONFIG, VwapReclaimConfig } from './vwap-reclaim';

export interface Bloc3Input {
  candidate: GainersScoredCandidate;
  /** Bougies intraday ordre chronologique (la plus récente en dernier). Min 5. */
  candles: CandleOHLCV[];
  /** Baseline volume 20j pour le surge check. null → surge désactivé. */
  volumeBaseline: number | null;
  detectedAt: string;
}

export interface GainersBloc3Config {
  pullbackHL: PullbackHLConfig;
  vwapReclaim: VwapReclaimConfig;
}

export const DEFAULT_BLOC3_CONFIG: GainersBloc3Config = {
  pullbackHL: DEFAULT_PULLBACK_HL_CONFIG,
  vwapReclaim: DEFAULT_VWAP_RECLAIM_CONFIG,
};

@Injectable()
export class GainersBloc3Service {
  evaluate(
    input: Bloc3Input,
    cfg: GainersBloc3Config = DEFAULT_BLOC3_CONFIG,
  ): GainersScoredCandidate {
    const { candidate, candles, volumeBaseline, detectedAt } = input;

    if (candidate.decision !== 'ACCEPT') return candidate;

    if (!candles || candles.length < 5) {
      return {
        ...candidate,
        decision: 'REJECT',
        rejectReason: CandidateRejectReason.NO_ENTRY_TRIGGER,
        entrySignal: null,
      };
    }

    const vwapResult = computeVwap(candles);
    const vwap = vwapResult.insufficient ? null : vwapResult.vwap;
    const baseline = volumeBaseline ?? 0;
    const { ema50Daily, ema200Daily } = candidate.raw;

    const pullback = evaluatePullbackHL(
      {
        symbol: candidate.raw.symbol,
        candles,
        volumeBaseline: baseline,
        ema50Daily,
        ema200Daily,
        vwap,
        detectedAt,
      },
      cfg.pullbackHL,
    );
    if (pullback) return { ...candidate, entrySignal: pullback };

    if (vwap !== null) {
      const reclaim = evaluateVwapReclaim(
        {
          symbol: candidate.raw.symbol,
          candles,
          vwap,
          ema50Daily,
          ema200Daily,
          volumeBaseline: baseline,
          detectedAt,
        },
        cfg.vwapReclaim,
      );
      if (reclaim) return { ...candidate, entrySignal: reclaim };
    }

    return {
      ...candidate,
      decision: 'REJECT',
      rejectReason: CandidateRejectReason.NO_ENTRY_TRIGGER,
      entrySignal: null,
    };
  }

  evaluateBatch(
    inputs: Bloc3Input[],
    cfg: GainersBloc3Config = DEFAULT_BLOC3_CONFIG,
  ): GainersScoredCandidate[] {
    return inputs.map((i) => this.evaluate(i, cfg));
  }
}
