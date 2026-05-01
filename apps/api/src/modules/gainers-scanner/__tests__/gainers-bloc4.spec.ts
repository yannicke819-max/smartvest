/**
 * BLOC 4 — Exits : viability, stops, invalidation, trailing 40/70.
 * Stubs créés en PR1 skeleton. Implémentation dans PR5.
 */

describe.skip('GainersBloc4 — exits & trailing', () => {
  describe('cost coverage viability', () => {
    it.todo('rejects trade when TP - entry < spread + fees × 2');
    it.todo('accepts trade when net reward covers round-trip cost');
  });

  describe('stop-loss', () => {
    it.todo('triggers SL exit when price <= entry × (1 - sl_pct)');
    it.todo('emits ExitReason.SL with correct estimatedPnlPct');
  });

  describe('take-profit full', () => {
    it.todo('triggers TP exit when price >= entry × (1 + tp_pct)');
    it.todo('emits ExitReason.TP_FULL');
  });

  describe('trailing — breakeven at MFE 40%', () => {
    it.todo('raises stop to breakeven when MFE >= 40% of TP pct');
    it.todo('emits InvalidationReason.TRAILING_BREAKEVEN_TRIGGERED');
    it.todo('does not re-lower stop once at breakeven');
  });

  describe('trailing — lock 50% TP at MFE 70%', () => {
    it.todo('locks 50% of TP pct when MFE >= 70%');
    it.todo('emits InvalidationReason.TRAILING_LOCK_50_TRIGGERED');
    it.todo('emits ExitReason.TP_PARTIAL_LOCK on trigger');
  });

  describe('time limit', () => {
    it.todo('emits ExitReason.TIME_LIMIT after max_hold_minutes elapsed');
  });

  describe('invalidation — persistence lost', () => {
    it.todo('emits InvalidationReason.PERSISTENCE_LOST when score drops post-entry');
    it.todo('emits ExitReason.INVALIDATION');
  });

  describe('invalidation — spread expanded', () => {
    it.todo('emits InvalidationReason.SPREAD_EXPANDED when spread > cap post-entry');
  });
});
