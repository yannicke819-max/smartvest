/**
 * BLOC 4 — Position state machine + TP/SL initial + trailing 20/50.
 * Tests des helpers purs (tp-sl, trailing-engine) + scénarios state machine complets.
 */

import { ExitReason, PositionState, EntryTriggerKind } from '../domain/gainers-enums';
import { computeInitialTpSl, DEFAULT_TP_SL_CONFIG } from '../bloc4/tp-sl';
import {
  applyTick,
  replayTicks,
  PositionSnapshot,
  DEFAULT_TRAILING_CONFIG,
} from '../bloc4/trailing-engine';
import { PositionsManagerService } from '../bloc4/positions-manager.service';

// ─── computeInitialTpSl ───────────────────────────────────────────────────────

describe('computeInitialTpSl()', () => {
  it('equity: TP = path_eff × 1.5, SL = path_eff × 1.0', () => {
    // entry $100, path_eff 0.6 (= 0.6%) → TP 0.9% = $100.90, SL 0.6% = $99.40
    const r = computeInitialTpSl({ entryPrice: 100, pathEff: 0.6, marketClass: 'equity' });
    expect(r.tpPct).toBeCloseTo(0.009, 6);
    expect(r.slPct).toBeCloseTo(0.006, 6);
    expect(r.tpPrice).toBeCloseTo(100.90, 4);
    expect(r.slPrice).toBeCloseTo(99.40, 4);
  });

  it('crypto: TP = path_eff × 2.0, SL = path_eff × 0.8', () => {
    // entry $60000, path_eff 0.6 → TP 1.2% = $60720, SL 0.48% = $59712
    const r = computeInitialTpSl({ entryPrice: 60_000, pathEff: 0.6, marketClass: 'crypto' });
    expect(r.tpPct).toBeCloseTo(0.012, 6);
    expect(r.slPct).toBeCloseTo(0.0048, 6);
    expect(r.tpPrice).toBeCloseTo(60_720, 0);
    expect(r.slPrice).toBeCloseTo(59_712, 0);
  });

  it('zero path_eff → degenerate TP=SL=entry', () => {
    const r = computeInitialTpSl({ entryPrice: 100, pathEff: 0, marketClass: 'equity' });
    expect(r.tpPrice).toBe(100);
    expect(r.slPrice).toBe(100);
  });
});

// ─── applyTick — state machine transitions ────────────────────────────────────

const buildOpenPosition = (entry = 100, pathEff = 0.6): PositionSnapshot => ({
  state: PositionState.OPEN,
  entryPrice: entry,
  pathEff,
  tpPrice: entry * 1.009,    // +0.9% (equity)
  initialSlPrice: entry * 0.994, // -0.6%
  currentStopPrice: entry * 0.994,
  mfePrice: entry,
});

describe('applyTick() — OPEN state', () => {
  it('hits SL → CLOSED with ExitReason.SL', () => {
    const r = applyTick({ position: buildOpenPosition(), currentPrice: 99.40 });
    expect(r.newState).toBe(PositionState.CLOSED);
    expect(r.exitReason).toBe(ExitReason.SL);
  });

  it('hits TP → CLOSED with ExitReason.TP_FULL', () => {
    const r = applyTick({ position: buildOpenPosition(), currentPrice: 101 });
    expect(r.newState).toBe(PositionState.CLOSED);
    expect(r.exitReason).toBe(ExitReason.TP_FULL);
  });

  it('reaches +path_eff gain → transitions to TRAILING_20', () => {
    // gain >= +0.6% → TRAILING_20
    const r = applyTick({ position: buildOpenPosition(), currentPrice: 100.65 });
    expect(r.newState).toBe(PositionState.TRAILING_20);
    expect(r.stateTransition).toBe('TO_TRAILING_20');
    // Stop ratchet: entry × (1 + 0.20 × MFE_gain%) where MFE_gain% = 0.65
    // = 100 × (1 + 0.20 × 0.65/100) = 100 × 1.0013 = 100.13
    expect(r.newStopPrice).toBeCloseTo(100.13, 2);
  });

  it('does not transition when gain < path_eff', () => {
    const r = applyTick({ position: buildOpenPosition(), currentPrice: 100.30 });
    expect(r.newState).toBe(PositionState.OPEN);
    expect(r.stateTransition).toBeNull();
  });

  it('keeps stop unchanged when no transition (still OPEN)', () => {
    const r = applyTick({ position: buildOpenPosition(), currentPrice: 100.30 });
    expect(r.newStopPrice).toBeCloseTo(99.40, 4);
  });
});

describe('applyTick() — TRAILING_20 state', () => {
  const buildT20 = (mfe = 100.65, stop = 100.13): PositionSnapshot => ({
    ...buildOpenPosition(),
    state: PositionState.TRAILING_20,
    mfePrice: mfe,
    currentStopPrice: stop,
  });

  it('hits trailing stop → CLOSED with TRAILING_20_HIT', () => {
    const r = applyTick({ position: buildT20(), currentPrice: 100.10 });
    expect(r.newState).toBe(PositionState.CLOSED);
    expect(r.exitReason).toBe(ExitReason.TRAILING_20_HIT);
  });

  it('does NOT close on TP from TRAILING_20 — TP cap is lifted, let winners run', () => {
    // Price 101 > tp 100.90 BUT we're in TRAILING_20 → no close
    // gain 1.0% < 2×path_eff (1.2%) → still TRAILING_20
    // ratchet: max(stop=100.13, 100×(1+0.20×1.0/100)=100.20) = 100.20
    const r = applyTick({ position: buildT20(), currentPrice: 101 });
    expect(r.newState).toBe(PositionState.TRAILING_20);
    expect(r.exitReason).toBeNull();
    expect(r.newStopPrice).toBeCloseTo(100.20, 2);
  });

  it('reaches +2×path_eff gain → transitions to TRAILING_50', () => {
    // gain >= +1.2% → TRAILING_50 (path_eff=0.6, threshold = 1.2%)
    const r = applyTick({ position: buildT20(), currentPrice: 101.20 });
    expect(r.newState).toBe(PositionState.TRAILING_50);
    expect(r.stateTransition).toBe('TO_TRAILING_50');
  });

  it('ratchets stop higher as MFE grows', () => {
    // current MFE was 100.65 → stop 100.13. Now price 100.80 (still < 2×path_eff=101.20)
    // newMfe = 100.80, mfe_gain_pct = 0.80
    // new stop = entry × (1 + 0.20 × 0.80/100) = 100 × 1.0016 = 100.16
    const r = applyTick({ position: buildT20(), currentPrice: 100.80 });
    expect(r.newState).toBe(PositionState.TRAILING_20);
    expect(r.newStopPrice).toBeCloseTo(100.16, 2);
  });

  it('stop never goes down (ratchet)', () => {
    // mfe stays at 100.65, current price drops back to 100.50
    // calc would give 100 × (1 + 0.20 × 0.65/100) = 100.13 (same as current stop)
    const r = applyTick({ position: buildT20(100.65, 100.13), currentPrice: 100.50 });
    expect(r.newStopPrice).toBeCloseTo(100.13, 4);
  });
});

describe('applyTick() — TRAILING_50 state', () => {
  const buildT50 = (mfe = 101.20, stop = 100.60): PositionSnapshot => ({
    ...buildOpenPosition(),
    state: PositionState.TRAILING_50,
    mfePrice: mfe,
    currentStopPrice: stop,
  });

  it('hits trailing stop → CLOSED with TRAILING_50_HIT', () => {
    const r = applyTick({ position: buildT50(), currentPrice: 100.55 });
    expect(r.newState).toBe(PositionState.CLOSED);
    expect(r.exitReason).toBe(ExitReason.TRAILING_50_HIT);
  });

  it('does NOT close on TP from TRAILING_50 — TP cap is lifted', () => {
    // price 101 > tp 100.90 but we're in TRAILING_50 → still open
    const r = applyTick({ position: buildT50(), currentPrice: 101 });
    expect(r.newState).toBe(PositionState.TRAILING_50);
    expect(r.exitReason).toBeNull();
  });

  it('ratchets stop with 50% lock factor', () => {
    // mfe 101.30, gain 1.30%, stop = 100 × (1 + 0.50 × 1.30/100) = 100.65
    const r = applyTick({ position: buildT50(), currentPrice: 101.30 });
    expect(r.newState).toBe(PositionState.TRAILING_50);
    expect(r.newStopPrice).toBeCloseTo(100.65, 2);
  });

  it('does not regress to TRAILING_20', () => {
    // Even with low gain (e.g. price drop to TRAILING_20 zone), state stays TRAILING_50
    // until stop is hit. Test: snap is TRAILING_50, price 100.85 (> stop 100.60).
    const r = applyTick({ position: buildT50(101.20, 100.60), currentPrice: 100.85 });
    expect(r.newState).toBe(PositionState.TRAILING_50);
  });
});

// ─── replayTicks() — 3 scénarios maître d'œuvre ──────────────────────────────

describe('replayTicks() — 3 scénarios state machine canoniques', () => {
  it('SCENARIO 1 — WIN: entry → TRAILING_20 → TRAILING_50 → TRAILING_50_HIT (locked profit)', () => {
    // path_eff = 0.6, entry = 100. TP=100.90, but TP cap is lifted in TRAILING_*.
    // 100.30 : OPEN, gain 0.30% < path_eff → no transition
    // 100.65 : gain 0.65% ≥ path_eff → TRAILING_20, stop = 100×(1+0.20×0.65/100) = 100.13
    // 101.30 : gain 1.30% ≥ 2×path_eff → TRAILING_50, MFE=101.30, stop = max(100.13, 100.65) = 100.65
    // 101.10 : still TRAILING_50, MFE stays 101.30, stop stays 100.65 (ratchet)
    // 100.50 : 100.50 ≤ 100.65 → TRAILING_50_HIT exit at 100.50 (locked +0.50%)
    const initial = buildOpenPosition();
    const prices = [100.30, 100.65, 101.30, 101.10, 100.50];
    const r = replayTicks(initial, prices);
    expect(r.exitReason).toBe(ExitReason.TRAILING_50_HIT);
    expect(r.exitPrice).toBe(100.50);
    expect(r.transitions).toEqual([
      { index: 1, transition: 'TO_TRAILING_20' },
      { index: 2, transition: 'TO_TRAILING_50' },
    ]);
  });

  it('SCENARIO 2 — BREAKEVEN-AVOIDED via trailing_20: entry → +path_eff → reversal → TRAILING_20_HIT (above entry)', () => {
    // path_eff 0.6, entry 100. Price reaches 100.70 (T20 activates, stop 100.14),
    // then drops to 100.10 → trailing_20_hit at 100.10 (loss avoided, even at small gain).
    // Wait, stop is 100.14, so price 100.10 < 100.14 triggers exit at 100.10.
    // Net result: exit at 100.10, just above entry 100 → "breakeven-avoided" (loss minimized).
    const initial = buildOpenPosition();
    const prices = [100.70, 100.10];
    const r = replayTicks(initial, prices);
    expect(r.exitReason).toBe(ExitReason.TRAILING_20_HIT);
    expect(r.exitPrice).toBe(100.10);
    expect(r.transitions).toEqual([{ index: 0, transition: 'TO_TRAILING_20' }]);
  });

  it('SCENARIO 3 — FULL LOSS: entry → reversal direct → SL', () => {
    // No favorable move, price drops directly to SL 99.40
    const initial = buildOpenPosition();
    const prices = [99.80, 99.50, 99.40];
    const r = replayTicks(initial, prices);
    expect(r.exitReason).toBe(ExitReason.SL);
    expect(r.exitPrice).toBe(99.40);
    expect(r.transitions).toEqual([]);
  });

  it('SCENARIO 4 — GAP_UP_TP_HIT: gap-up direct OPEN→TP sans passer par +path_eff', () => {
    // entry 100, TP 100.90. Gap-up à 101.08 (= +1.8×path_eff) → TP_FULL en OPEN.
    // Confirme : gap-up déclenche TP avant promotion trailing (spec officielle).
    const initial = buildOpenPosition();
    const prices = [101.08];
    const r = replayTicks(initial, prices);
    expect(r.exitReason).toBe(ExitReason.TP_FULL);
    expect(r.exitPrice).toBe(101.08);
    expect(r.transitions).toEqual([]); // pas de promotion trailing
  });

  it('SCENARIO 5 — TP_REACHED_IN_OPEN_WITHOUT_TRAILING (rename: T20 wins, TP cap lifted)', () => {
    // path_eff=0.6, TP=100.90.
    // Slow ascent: 100.65 (T20, MFE 100.65, stop 100.13)
    //              100.78 (T20, MFE 100.78, gain 0.78% < 2×path_eff, stop = max(100.13, 100×(1+0.20×0.78/100)) = 100.156)
    //              101.00 (T20 — TP cap LEVÉ, gain 1.00% < 1.20% T50 threshold, MFE 101.00, stop = max(100.156, 100×(1+0.20×1.00/100)) = 100.20)
    //              100.10 (100.10 ≤ 100.20 → T20_HIT at 100.10, locked +0.10% above entry)
    // Vérifie : malgré price 101 > TP 100.90, position reste OPEN (TP cap lifted en T20),
    // et finit par sortir au trailing 20 — pas au TP.
    const initial = buildOpenPosition();
    const prices = [100.65, 100.78, 101.00, 100.10];
    const r = replayTicks(initial, prices);
    expect(r.exitReason).toBe(ExitReason.TRAILING_20_HIT);
    expect(r.exitPrice).toBe(100.10);
    expect(r.transitions).toEqual([{ index: 0, transition: 'TO_TRAILING_20' }]);
    expect(r.finalSnapshot.state).toBe(PositionState.CLOSED);
    expect(r.finalSnapshot.mfePrice).toBeCloseTo(101.00, 4);
    // realized gain = (100.10 - 100) / 100 = 0.001 = 0.1%
    const realizedGainPct = (r.exitPrice! - initial.entryPrice) / initial.entryPrice;
    expect(realizedGainPct).toBeCloseTo(0.001, 4);
  });

  it('handles closed position no-op', () => {
    const closed: PositionSnapshot = { ...buildOpenPosition(), state: PositionState.CLOSED };
    const r = applyTick({ position: closed, currentPrice: 101 });
    expect(r.newState).toBe(PositionState.CLOSED);
    expect(r.exitReason).toBeNull();
    expect(r.slippagePct).toBeNull();
    expect(r.anomalousFill).toBe(false);
  });
});

// ─── Slippage + anomalous_fill (Garde-fou ADR-005 §11.3) ─────────────────────

describe('slippage tracking — ADR-005 §11.3', () => {
  it('TP_FULL: slippage = (actual - tp_price) / entry, positif sur gap-up favorable', () => {
    // entry 100, TP 100.90, gap-up à 101.00 → slippage = (101-100.90)/100 = +0.001 = +0.1%
    const r = applyTick({ position: buildOpenPosition(), currentPrice: 101.00 });
    expect(r.exitReason).toBe(ExitReason.TP_FULL);
    expect(r.slippagePct).toBeCloseTo(0.001, 5);
    expect(r.anomalousFill).toBe(false);
  });

  it('SL: slippage = (actual - sl_price) / entry, négatif si tick sous le stop', () => {
    // entry 100, SL 99.40, tick à 99.30 → slippage = (99.30-99.40)/100 = -0.001 = -0.1%
    const r = applyTick({ position: buildOpenPosition(), currentPrice: 99.30 });
    expect(r.exitReason).toBe(ExitReason.SL);
    expect(r.slippagePct).toBeCloseTo(-0.001, 5);
    expect(r.anomalousFill).toBe(false);
  });

  it('SL exact: slippage = 0 (fill exactement au niveau)', () => {
    const r = applyTick({ position: buildOpenPosition(), currentPrice: 99.40 });
    expect(r.exitReason).toBe(ExitReason.SL);
    expect(r.slippagePct).toBeCloseTo(0, 6);
  });

  it('anomalous_fill flag: |slippage| > 1% → true', () => {
    // gap-up massive at 102 (entry 100, TP 100.90, slippage = (102-100.90)/100 = 1.10% > 1%)
    const r = applyTick({ position: buildOpenPosition(), currentPrice: 102.00 });
    expect(r.exitReason).toBe(ExitReason.TP_FULL);
    expect(r.slippagePct).toBeCloseTo(0.011, 4);
    expect(r.anomalousFill).toBe(true);
  });

  it('anomalous_fill SL: gap-down massive (halt) → true', () => {
    // SL 99.40, tick à 98.00 → slippage = (98-99.40)/100 = -1.4% > 1% absolute
    const r = applyTick({ position: buildOpenPosition(), currentPrice: 98.00 });
    expect(r.exitReason).toBe(ExitReason.SL);
    expect(r.slippagePct).toBeCloseTo(-0.014, 4);
    expect(r.anomalousFill).toBe(true);
  });

  it('non-exit ticks: slippagePct=null, anomalousFill=false', () => {
    const r = applyTick({ position: buildOpenPosition(), currentPrice: 100.30 });
    expect(r.exitReason).toBeNull();
    expect(r.slippagePct).toBeNull();
    expect(r.anomalousFill).toBe(false);
  });

  it('replayTicks surfaces exitSlippagePct and exitAnomalousFill', () => {
    // SCENARIO 1 dryrun: gap-up à 202.55, TP 202.0562 → slippage ≈ +0.250%
    const initial: PositionSnapshot = {
      state: PositionState.OPEN,
      entryPrice: 197.61,
      pathEff: 1.5,
      tpPrice: 202.0562,
      initialSlPrice: 194.6459,
      currentStopPrice: 194.6459,
      mfePrice: 197.61,
    };
    const r = replayTicks(initial, [202.55]);
    expect(r.exitReason).toBe(ExitReason.TP_FULL);
    expect(r.exitSlippagePct).toBeCloseTo(0.0025, 4);
    expect(r.exitAnomalousFill).toBe(false);
  });
});

// ─── PositionsManagerService — light wiring smoke (mocked Supabase) ──────────

describe('PositionsManagerService', () => {
  it('is instantiable with a Supabase mock', () => {
    const mockSupabase = { getClient: () => ({}) } as any;
    expect(new PositionsManagerService(mockSupabase)).toBeDefined();
  });

  it('exports DEFAULT_TP_SL_CONFIG and DEFAULT_TRAILING_CONFIG with locked values', () => {
    expect(DEFAULT_TP_SL_CONFIG.equityTpMultiplier).toBe(1.5);
    expect(DEFAULT_TP_SL_CONFIG.equitySlMultiplier).toBe(1.0);
    expect(DEFAULT_TP_SL_CONFIG.cryptoTpMultiplier).toBe(2.0);
    expect(DEFAULT_TP_SL_CONFIG.cryptoSlMultiplier).toBe(0.8);
    expect(DEFAULT_TRAILING_CONFIG.trailing20LockFraction).toBe(0.20);
    expect(DEFAULT_TRAILING_CONFIG.trailing50LockFraction).toBe(0.50);
  });

  // Note: openPosition + onTick I/O are best validated end-to-end with a real
  // Supabase fixture (out of scope for unit tests — see PR6 shadow harness).
  it('uses EntryTriggerKind enum values for trigger_kind validation', () => {
    expect(EntryTriggerKind.PULLBACK_HL_FIBO).toBe('PULLBACK_HL_FIBO');
    expect(EntryTriggerKind.VWAP_RECLAIM).toBe('VWAP_RECLAIM');
  });
});
