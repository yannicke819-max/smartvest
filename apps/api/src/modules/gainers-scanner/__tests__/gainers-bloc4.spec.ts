/**
 * BLOC 4 — Exits : viability, stops, invalidation, trailing 40/70.
 * Stubs créés en PR1 skeleton. Implémentation dans PR5.
 */

describe.skip('GainersBloc4 — exits & trailing', () => {
  describe('cost coverage viability', () => {
    it('rejects trade when TP - entry < spread + fees × 2');
    it('accepts trade when net reward covers round-trip cost');
  });

  describe('stop-loss', () => {
    it('triggers SL exit when price <= entry × (1 - sl_pct)');
    it('emits ExitReason.SL with correct estimatedPnlPct');
  });

  describe('take-profit full', () => {
    it('triggers TP exit when price >= entry × (1 + tp_pct)');
    it('emits ExitReason.TP_FULL');
  });

  describe('trailing — breakeven at MFE 40%', () => {
    it('raises stop to breakeven when MFE >= 40% of TP pct');
    it('emits InvalidationReason.TRAILING_BREAKEVEN_TRIGGERED');
    it('does not re-lower stop once at breakeven');
  });

  describe('trailing — lock 50% TP at MFE 70%', () => {
    it('locks 50% of TP pct when MFE >= 70%');
    it('emits InvalidationReason.TRAILING_LOCK_50_TRIGGERED');
    it('emits ExitReason.TP_PARTIAL_LOCK on trigger');
  });

  describe('time limit', () => {
    it('emits ExitReason.TIME_LIMIT after max_hold_minutes elapsed');
  });

  describe('invalidation — persistence lost', () => {
    it('emits InvalidationReason.PERSISTENCE_LOST when score drops post-entry');
    it('emits ExitReason.INVALIDATION');
  });

  describe('invalidation — spread expanded', () => {
    it('emits InvalidationReason.SPREAD_EXPANDED when spread > cap post-entry');
  });
});
