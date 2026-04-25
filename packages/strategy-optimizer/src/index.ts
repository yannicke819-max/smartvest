export {
  type SearchSpace,
  SearchSpaceSchema,
  type OptimizerCandidate,
  type ScoredCandidate,
  type OptimizerLeaderboard,
  type OptimizerRunMode,
  OptimizerRunModeSchema,
  type OptimizerRunParams,
  OptimizerRunParamsSchema,
  type OptimizerRunResult,
  type AutoApplyDecision,
  type AutoApplyState,
  candidateToBacktestConfig,
} from './types';

export {
  expandCartesian,
  expandOrthogonal,
  expandSearchSpace,
  DEFAULT_SEARCH_SPACE,
} from './search-space';

export {
  type ScoringWeights,
  DEFAULT_WEIGHTS,
  computeCompositeScore,
  rankCandidates,
  computeStabilityScore,
} from './scorer';

export { runSingleShot } from './single-shot';
export { runWalkForward, splitDates } from './walk-forward';
export { evaluateAutoApply, AUTO_APPLY_THRESHOLDS } from './auto-apply';
