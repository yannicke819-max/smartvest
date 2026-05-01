/**
 * BLOC 3 — Entry triggers.
 * Stubs créés en PR1 skeleton. Implémentation dans PR4.
 */

describe.skip('GainersBloc3 — entry triggers', () => {
  describe('pullback_HL_fibo', () => {
    it.todo('detects swing high N=5 (Bulkowski)');
    it.todo('detects swing low N=5');
    it.todo('validates retracement within 38.2–61.8% Fibonacci range');
    it.todo('rejects retracement below 38.2%');
    it.todo('rejects retracement above 61.8%');
    it.todo('emits PULLBACK_HL_FIBO signal with fiboLevel, swingHigh, swingLow');
  });

  describe('vwap_reclaim', () => {
    it.todo('detects price crossing above VWAP intraday');
    it.todo('confirms EMA50 daily > EMA200 daily at signal');
    it.todo('emits VWAP_RECLAIM signal with vwap, ema50Daily, ema200Daily');
    it.todo('skips signal when EMA50 < EMA200 (trend not aligned)');
  });

  describe('trigger priority', () => {
    it.todo('returns PULLBACK_HL_FIBO when both triggers valid (higher conviction)');
    it.todo('returns VWAP_RECLAIM when only vwap trigger detected');
    it.todo('emits NO_ENTRY_TRIGGER rejection when neither trigger found');
  });
});
