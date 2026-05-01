/**
 * BLOC 1 — Scoring + prefilter gates.
 * Stubs créés en PR1 skeleton. Implémentation dans PR2.
 */

describe.skip('GainersBloc1 — prefilter gates', () => {
  describe('liquidity floor', () => {
    it.todo('rejects equity candidate below $10M median daily vol');
    it.todo('rejects crypto candidate below $50M 24h vol');
    it.todo('accepts equity candidate at exactly $10M');
  });

  describe('market cap minimum', () => {
    it.todo('rejects equity below $300M');
    it.todo('rejects crypto below $500M');
    it.todo('accepts equity at exactly $300M');
  });

  describe('volatility clamp', () => {
    it.todo('rejects candidate with ATR(14)/close > 0.15');
    it.todo('accepts candidate with ATR(14)/close = 0.15');
  });

  describe('RVOL cumulative intraday', () => {
    it.todo('computes vol_open→now / avg_same_window_20_trading_days for equity');
    it.todo('computes vol_00:00→now for crypto');
    it.todo('rejects candidate below RVOL threshold');
  });

  describe('persistence gate', () => {
    it.todo('rejects candidate with persistenceScore below gainers_min_persistence_score');
    it.todo('accepts candidate with score >= threshold');
  });

  describe('composite scorer', () => {
    it.todo('returns compositeScore in [0, 1] for ACCEPT candidates');
    it.todo('returns null compositeScore for REJECT candidates');
  });
});
