export {
  BacktestConfigSchema,
  type BacktestConfig,
  type BacktestResult,
  type BacktestMetrics,
  type BacktestTrade,
  type BacktestPosition,
  type EquityPoint,
  type Candle,
  type TickerHistory,
} from './types';

export {
  loadUniverseHistory,
  extractTradingDates,
  candleAt,
  DEFAULT_UNIVERSE,
} from './data-replay';

export { runBacktest } from './runner';

export { computeMetrics } from './metrics';

export { applySlippage, applyFee } from './slippage';

export {
  generateProposals,
  scoreSetup,
  computeSignals,
  type MockProposal,
  type MockSignals,
} from './lisa-mock';
