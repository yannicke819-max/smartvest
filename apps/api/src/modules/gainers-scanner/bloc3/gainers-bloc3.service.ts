/**
 * BLOC 3 — Évaluation des triggers d'entrée (ADR-005).
 *
 * Ordre d'évaluation : PULLBACK_HL_FIBO → VWAP_RECLAIM → NO_ENTRY_TRIGGER.
 * Le premier trigger qui matche est retenu ; les deux ne sont jamais émis simultanément.
 *
 * Ce service est pur-fonction côté logique métier (pas d'I/O) ; les données
 * (candles, VWAP, baselines) sont fournies par l'orchestrateur externe.
 *
 * Issue #193 (P1) : chaque candidat ACCEPT ou REJECT reçoit un Bloc3Diagnostics
 * avec timestamp/resolution/session/spread/volume/gateLiquidity/pivots — surface
 * pour decision_log audit + dashboard observability Step 10.
 */

import { Injectable } from '@nestjs/common';
import type { GainersScoredCandidate, Bloc3Diagnostics } from '../domain/gainers-candidate.types';
import { CandidateRejectReason } from '../domain/gainers-enums';
import type { CandleOHLCV } from '../bloc2/spread-proxy';
import { computeVwap } from './vwap';
import { computeSwingPivots } from './swing-pivot';
import { evaluatePullbackHL, DEFAULT_PULLBACK_HL_CONFIG, PullbackHLConfig } from './pullback-hl';
import { evaluateVwapReclaim, DEFAULT_VWAP_RECLAIM_CONFIG, VwapReclaimConfig } from './vwap-reclaim';
import { detectSession } from './session-detector';

export interface Bloc3Input {
  candidate: GainersScoredCandidate;
  /** Bougies intraday ordre chronologique (la plus récente en dernier). Min 5. */
  candles: CandleOHLCV[];
  /** Baseline volume 20j pour le surge check. null → surge désactivé. */
  volumeBaseline: number | null;
  detectedAt: string;
  /** Résolution des candles (issue #193 — log diagnostics). Défaut '1h'. */
  resolution?: '1m' | '5m' | '1h' | 'daily';
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
    const resolution = input.resolution ?? '1h';

    // Diagnostics shell — populé partiellement selon le chemin emprunté.
    const diagnosticsBase: Bloc3Diagnostics = {
      timestamp: detectedAt,
      resolution,
      session: detectSession(detectedAt, candidate.raw.market),
      spreadProxy: candidate.spreadProxy,
      volumeRatio: null,
      gateLiquidityPassed: candidate.decision === 'ACCEPT' || (
        // BLOC 1/2 REJECT identifié par rejectReason — gate failed
        candidate.rejectReason !== CandidateRejectReason.LIQUIDITY_FLOOR &&
        candidate.rejectReason !== CandidateRejectReason.SPREAD_TOO_WIDE
      ),
      pivotsDetected: 0,
      pivotsReason: null,
    };

    // BLOC 1/2 REJECT déjà acté → on log les diagnostics partiels et passe.
    if (candidate.decision !== 'ACCEPT') {
      return {
        ...candidate,
        bloc3Diagnostics: { ...diagnosticsBase, pivotsReason: null },
      };
    }

    // BLOC 3 path actif — calcul VWAP, pivots, baseline ratio.
    if (!candles || candles.length < 5) {
      return {
        ...candidate,
        decision: 'REJECT',
        rejectReason: CandidateRejectReason.NO_ENTRY_TRIGGER,
        entrySignal: null,
        bloc3Diagnostics: {
          ...diagnosticsBase,
          pivotsDetected: 0,
          pivotsReason: 'CANDLE_COUNT_BELOW_9',
        },
      };
    }

    const vwapResult = computeVwap(candles);
    const vwap = vwapResult.insufficient ? null : vwapResult.vwap;
    const baseline = volumeBaseline ?? 0;
    const { ema50Daily, ema200Daily } = candidate.raw;

    // Pivots N=5 + diagnostic raison absence
    const pivots = computeSwingPivots(
      candles.map((c) => c.high),
      candles.map((c) => c.low),
    );
    const pivotsCount = (pivots.swingHigh ? 1 : 0) + (pivots.swingLow ? 1 : 0);

    // Volume ratio — current candle vs baseline
    const lastCandle = candles[candles.length - 1];
    const volumeRatio =
      baseline > 0 && lastCandle.volume > 0
        ? (lastCandle.volume * lastCandle.close) / baseline
        : null;

    const diagnostics: Bloc3Diagnostics = {
      ...diagnosticsBase,
      volumeRatio,
      pivotsDetected: pivotsCount,
      pivotsReason: pivots.noPivotReason,
    };

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
    if (pullback) {
      return { ...candidate, entrySignal: pullback, bloc3Diagnostics: diagnostics };
    }

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
      if (reclaim) {
        return { ...candidate, entrySignal: reclaim, bloc3Diagnostics: diagnostics };
      }
    }

    return {
      ...candidate,
      decision: 'REJECT',
      rejectReason: CandidateRejectReason.NO_ENTRY_TRIGGER,
      entrySignal: null,
      bloc3Diagnostics: diagnostics,
    };
  }

  evaluateBatch(
    inputs: Bloc3Input[],
    cfg: GainersBloc3Config = DEFAULT_BLOC3_CONFIG,
  ): GainersScoredCandidate[] {
    return inputs.map((i) => this.evaluate(i, cfg));
  }
}
