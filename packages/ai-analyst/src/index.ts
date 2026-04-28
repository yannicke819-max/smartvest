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
export * from './backtest/engine';
export * from './backtest/metrics';
export * from './backtest/runner';
