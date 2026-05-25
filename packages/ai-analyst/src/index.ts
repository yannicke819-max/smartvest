/**
 * @smartvest/ai-analyst
 *
 * Lisa — Multi-asset agnostic AI analyst for SmartVest.
 * Cross-asset thesis generation, historical analog matching,
 * risk-constrained allocation proposals. Simulation-first.
 */
export * from './types';
export * from './persona';
export * from './claude';
export * from './corpus';
export * from './thesis';
export * from './allocation';
export * from './simulation';
export * from './llm';
export * from './regime';
export * from './strategies/rebound-tp';
export * from './strategies/universes';
export * from './strategies/rsi-prefilter';
export * from './strategies/session-windows';
export * from './strategies/session-filter';
export * from './strategies/proposal-source-routing';
export * from './strategies/top-gainers-filter';
export * from './strategies/multi-tf-persistence';
export * from './strategies/logistic-regression';
export * from './strategies/empirical-law';
export * from './strategies/path-quality';
export * from './strategies/bootstrap-ci';
export * from './backtest/engine';
export * from './backtest/metrics';
export * from './backtest/runner';
export * from './scoring/continuous-score';
export * from './decisions/trading-decision';
export * from './decisions/signal-half-life';
export * from './decisions/debate-orchestrator';
export * from './decisions/strategy-lifecycle';
export * from './decisions/macro-regime';
export * from './decisions/volatility-cartography';
export * from './decisions/capital-allocator';
