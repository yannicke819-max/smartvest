export {
  type MonteCarloConfig,
  MonteCarloConfigSchema,
  type MonteCarloResult,
  type MonteCarloStatistics,
  type PathResult,
} from './types';

export { runMonteCarlo } from './runner';
export {
  buildDailyReturnsTable,
  createRng,
  sampleIndices,
  type DailyReturns,
} from './bootstrap';
export { simulatePath, type SimulationContext } from './path-simulator';
export {
  computeStatistics,
  buildHistogram,
  buildFanChart,
  percentile,
  mean,
  type PathSummary,
} from './statistics';
