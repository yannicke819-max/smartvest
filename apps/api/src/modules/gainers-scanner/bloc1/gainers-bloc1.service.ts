/**
 * BLOC 1 — Service NestJS orchestrant prefilter-gates + trend-filter + composite-scorer.
 * Pas d'I/O direct : le caller fournit `GainersCandidateRaw` enrichi avec EMAs/ATR/persistence.
 */

import { Injectable } from '@nestjs/common';
import type {
  GainersCandidateRaw,
  GainersScoredCandidate,
} from '../domain/gainers-candidate.types';
import {
  DEFAULT_BLOC1_CONFIG,
  SHADOW_BLOC1_CONFIG,
  GainersBloc1Config,
  runAllPrefilterGates,
} from './prefilter-gates';
import {
  DEFAULT_TREND_FILTER_CONFIG,
  SHADOW_TREND_FILTER_CONFIG,
  TrendFilterConfig,
  evaluateTrendFilter,
} from './trend-filter';
import {
  DEFAULT_COMPOSITE_SCORER_CONFIG,
  SHADOW_COMPOSITE_SCORER_CONFIG,
  CompositeScorerConfig,
  computeCompositeScore,
} from './composite-scorer';

export interface Bloc1FullConfig {
  prefilter: GainersBloc1Config;
  trendFilter: TrendFilterConfig;
  scorer: CompositeScorerConfig;
}

export const DEFAULT_BLOC1_FULL_CONFIG: Bloc1FullConfig = {
  prefilter: DEFAULT_BLOC1_CONFIG,
  trendFilter: DEFAULT_TREND_FILTER_CONFIG,
  scorer: DEFAULT_COMPOSITE_SCORER_CONFIG,
};

/**
 * PR6.6.5 + PR6.6.6 — Bloc1 full config pour shadow run.
 * Tolère null fields sur prefilter (PR6.4), trend filter (PR6.6.5),
 * et composite scorer best-effort partial (PR6.6.6 — composite_score
 * calculé même avec persistence/atr null, renormalize weights sur
 * composants présents).
 * Prod garde DEFAULT_BLOC1_FULL_CONFIG strict (ADR-005 §1bis lock).
 */
export const SHADOW_BLOC1_FULL_CONFIG: Bloc1FullConfig = {
  prefilter: SHADOW_BLOC1_CONFIG,
  trendFilter: SHADOW_TREND_FILTER_CONFIG,
  scorer: SHADOW_COMPOSITE_SCORER_CONFIG,
};

@Injectable()
export class GainersBloc1Service {
  /**
   * Évalue un candidat : prefilter-gates → trend-filter → composite-score.
   * Premier échec = REJECT court-circuité (autres dimensions non évaluées).
   */
  evaluate(raw: GainersCandidateRaw, cfg: Bloc1FullConfig = DEFAULT_BLOC1_FULL_CONFIG): GainersScoredCandidate {
    const prefilter = runAllPrefilterGates(raw, cfg.prefilter);
    if (!prefilter.pass) {
      return {
        raw,
        compositeScore: null,
        decision: 'REJECT',
        rejectReason: prefilter.firstFailedReason,
        spreadProxy: null,
        spreadProxySource: null,
        trendFilter: null,
        rvolIntraday: null,
      };
    }

    const trend = evaluateTrendFilter(raw, cfg.trendFilter);
    if (!trend.pass) {
      return {
        raw,
        compositeScore: null,
        decision: 'REJECT',
        rejectReason: trend.reason,
        spreadProxy: null,
        spreadProxySource: null,
        trendFilter: trend.kind,
        rvolIntraday: null,
      };
    }

    const compositeScore = computeCompositeScore(raw, cfg.scorer);
    return {
      raw,
      compositeScore,
      decision: 'ACCEPT',
      rejectReason: null,
      spreadProxy: null,
      spreadProxySource: null,
      trendFilter: trend.kind,
      rvolIntraday: null,
    };
  }

  /** Évalue un batch et retourne uniquement les ACCEPT triés par score décroissant. */
  evaluateBatchAccepted(
    raws: GainersCandidateRaw[],
    cfg: Bloc1FullConfig = DEFAULT_BLOC1_FULL_CONFIG,
  ): GainersScoredCandidate[] {
    return raws
      .map((r) => this.evaluate(r, cfg))
      .filter((c): c is GainersScoredCandidate => c.decision === 'ACCEPT')
      .sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));
  }
}
