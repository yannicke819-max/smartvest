/**
 * BLOC 2 — Baselines + spread proxy + universe guard.
 * Stubs créés en PR1 skeleton. Implémentation dans PR3.
 */

describe.skip('GainersBloc2 — baselines & spread proxy', () => {
  describe('spread proxy', () => {
    it.todo('computes HL_1M_MEDIAN = median((H-L)*0.5/close) over 5 last 1m candles');
    it.todo('computes HL_5M_MEDIAN for equity when 1m not available');
    it.todo('falls back to STATIC_CAP_FALLBACK when < 3/5 candles have vol > 0');
    it.todo('rejects candidate with spread proxy > 0.30%');
    it.todo('caps spread at 0.30% for static fallback source');
  });

  describe('trend filter EMA Golden Cross', () => {
    it.todo('returns EMA_GOLDEN_CROSS when EMA50 daily > EMA200 daily');
    it.todo('returns TREND_FILTER_FAIL rejection when EMA50 < EMA200');
    it.todo('returns NONE when trend filter disabled in config');
  });

  describe('volume baselines', () => {
    it.todo('loads medianDailyVol20d from gainers_volume_baselines table');
    it.todo('skips candidate when baseline missing and vol not computable live');
  });

  describe('universe guard', () => {
    it.todo('computes watchlist_hash = SHA256(sorted symbols)');
    it.todo('rejects candidate absent from non-regression universe');
    it.todo('emits drift warning when hash mismatch detected');
  });
});
