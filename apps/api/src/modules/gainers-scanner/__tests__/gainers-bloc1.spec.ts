/**
 * BLOC 1 — Scoring + prefilter gates.
 * Stubs créés en PR1 skeleton. Implémentation dans PR2.
 */

describe.skip('GainersBloc1 — prefilter gates', () => {
  describe('liquidity floor', () => {
    it('rejects equity candidate below $10M median daily vol');
    it('rejects crypto candidate below $50M 24h vol');
    it('accepts equity candidate at exactly $10M');
  });

  describe('market cap minimum', () => {
    it('rejects equity below $300M');
    it('rejects crypto below $500M');
    it('accepts equity at exactly $300M');
  });

  describe('volatility clamp', () => {
    it('rejects candidate with ATR(14)/close > 0.15');
    it('accepts candidate with ATR(14)/close = 0.15');
  });

  describe('RVOL cumulative intraday', () => {
    it('computes vol_open→now / avg_same_window_20_trading_days for equity');
    it('computes vol_00:00→now for crypto');
    it('rejects candidate below RVOL threshold');
  });

  describe('persistence gate', () => {
    it('rejects candidate with persistenceScore below gainers_min_persistence_score');
    it('accepts candidate with score >= threshold');
  });

  describe('composite scorer', () => {
    it('returns compositeScore in [0, 1] for ACCEPT candidates');
    it('returns null compositeScore for REJECT candidates');
  });
});
