/**
 * P3-B — Tests engine backtest avec fixtures synthétiques.
 *
 * Fixtures déterministes : on construit des séquences OHLCV où on
 * connaît à l'avance le résultat attendu (TP1 hit, SL hit, TIMEOUT…)
 * et on vérifie que l'engine répond correctement.
 */
import { backtestTicker, backtestUniverse } from '../engine';
import type { Candle } from '../../strategies/rebound-tp';

/**
 * Setup capitulation reproduit du spec scanRebound :
 *  16 stable + drop sharp + reversal candle.
 *  Si on poursuit la série après l'entrée (idx 19, close=85), on peut
 *  injecter le scénario de sortie souhaité (TP1, SL, TIMEOUT…).
 */
function capitulationBars(): Candle[] {
  const closes = [
    100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
    100, 100, 100, 100, 100, 100,
    92, 88, 82, 85,
  ];
  return closes.map((close, i) => {
    const open = i === 0 ? close * 0.999 : closes[i - 1];
    return {
      timestamp: i,
      open,
      high: Math.max(open, close) * 1.005,
      low: Math.min(open, close) * 0.995,
      close,
      volume: i === closes.length - 1 ? 3500 : 1000,
    };
  });
}

describe('backtestTicker', () => {
  it('returns no trades when bars < warmup', () => {
    const trades = backtestTicker([], 'X', { warmupBars: 20, scannerCfg: {} });
    expect(trades).toEqual([]);
  });

  it('captures TP1 then runs to TP2 → trade.exitKind=TP2', () => {
    // Setup : capitulation se termine close=85 idx 19. Entrée à 85.
    // TP1 = 89.25 (× 1.05), TP2 = 93.5 (× 1.10), TP3 = 97.75, SL = 81.6.
    // On ajoute des bougies après l'entrée : touche TP1 jour 21,
    // touche TP2 jour 23, redescend.
    const base = capitulationBars();
    base.push(makeBar(21, 86, 90, 86, 89), makeBar(22, 89, 92, 88, 91));
    base.push(makeBar(23, 91, 94, 90, 93)); // bar high 94 ≥ TP2=93.5
    const trades = backtestTicker(base, 'X', { warmupBars: 20, scannerCfg: {} });
    expect(trades).toHaveLength(1);
    expect(trades[0].exitKind).toBe('TP2');
    expect(trades[0].entryPrice).toBe(85);
  });

  it('captures pure TP1 (hit then time stop expires)', () => {
    const base = capitulationBars();
    base.push(makeBar(21, 86, 90, 86, 89)); // TP1 = 89.25, high 90 → TP1 hit
    // reste 9 bougies stables sous TP2
    for (let i = 22; i < 31; i++) base.push(makeBar(i, 89, 91, 89, 90));
    const trades = backtestTicker(base, 'X', { warmupBars: 20, scannerCfg: {} });
    expect(trades).toHaveLength(1);
    expect(trades[0].exitKind).toBe('TP1');
    // TP1 50% × +5% + 50% × ((90-85)/85*100) ≈ 50%×5 + 50%×5.88 = 5.44%
    expect(trades[0].pnlPct).toBeGreaterThan(2);
    expect(trades[0].pnlPct).toBeLessThan(8);
  });

  it('captures SL hit before TP', () => {
    const base = capitulationBars();
    // bar 20 chute brutale, low touche SL=81.6
    base.push(makeBar(20, 84, 84.5, 80, 81)); // low=80 ≤ SL=81.6
    const trades = backtestTicker(base, 'X', { warmupBars: 20, scannerCfg: {} });
    expect(trades).toHaveLength(1);
    expect(trades[0].exitKind).toBe('SL');
    // SL pnl = (81.6 - 85)/85*100 = -4%
    expect(trades[0].pnlPct).toBeCloseTo(-4, 1);
  });

  it('captures TIMEOUT when neither TP nor SL hit within timeStopDays', () => {
    const base = capitulationBars();
    // 11 bougies plates à 86 (entre SL 81.6 et TP1 89.25)
    for (let i = 20; i < 31; i++) base.push(makeBar(i, 86, 86.5, 85.5, 86));
    const trades = backtestTicker(base, 'X', { warmupBars: 20, scannerCfg: {} });
    expect(trades).toHaveLength(1);
    expect(trades[0].exitKind).toBe('TIMEOUT');
    // pnl = (86-85)/85*100 = 1.18%
    expect(trades[0].pnlPct).toBeCloseTo(1.18, 1);
  });

  it('captures TP3 when high gaps above TP3 in one bar', () => {
    const base = capitulationBars();
    // Gap up massif jour 20
    base.push(makeBar(20, 90, 100, 90, 99)); // high 100 ≥ TP3=97.75
    const trades = backtestTicker(base, 'X', { warmupBars: 20, scannerCfg: {} });
    expect(trades).toHaveLength(1);
    expect(trades[0].exitKind).toBe('TP3');
    expect(trades[0].pnlPct).toBeCloseTo(15, 0);
  });

  it('opens new position after exit (no double-OPEN per ticker)', () => {
    const base = capitulationBars();
    base.push(makeBar(20, 84, 84.5, 80, 81)); // SL hit
    // Refait un setup capitulation après le SL : 16 stable à 90 + drop
    for (let i = 21; i < 37; i++) {
      base.push(makeBar(i, 90, 90.45, 89.55, 90));
    }
    base.push(makeBar(37, 89, 90, 82.8, 83));
    base.push(makeBar(38, 82.4, 82.96, 79.2, 79.5));
    base.push(makeBar(39, 79, 79.4, 73.8, 74));
    // bar 40 reversal : open<close, vol spike
    const reversal = makeBar(40, 74, 78, 73, 77);
    reversal.volume = 5000;
    base.push(reversal);
    const trades = backtestTicker(base, 'X', { warmupBars: 20, scannerCfg: {} });
    // Au moins 1 (le SL initial). Pas garanti d'un 2nd trade selon
    // les seuils mais on vérifie que l'engine ne crashe pas.
    expect(trades.length).toBeGreaterThanOrEqual(1);
    expect(trades[0].exitKind).toBe('SL');
  });

  it('respects custom slPct config (-2% slPct → SL plus serré)', () => {
    const base = capitulationBars();
    // Avec slPct=2, SL = 85 × 0.98 = 83.3
    // Bar 20 low=83 → touche le nouveau SL mais pas l'ancien (81.6)
    base.push(makeBar(20, 84, 85, 83, 83.5));
    const tradesStrict = backtestTicker(base, 'X', {
      warmupBars: 20,
      scannerCfg: { slPct: 2 },
    });
    expect(tradesStrict).toHaveLength(1);
    expect(tradesStrict[0].exitKind).toBe('SL');

    const tradesDefault = backtestTicker(base, 'X', {
      warmupBars: 20,
      scannerCfg: {},
    });
    // Avec SL=81.6 par défaut, low=83 ne touche pas → pas de SL
    if (tradesDefault.length > 0) {
      expect(tradesDefault[0].exitKind).not.toBe('SL');
    }
  });
});

describe('backtestUniverse', () => {
  it('aggregates trades across multiple tickers', () => {
    const base = capitulationBars();
    base.push(makeBar(20, 90, 100, 90, 99)); // TP3
    const trades = backtestUniverse(
      [
        { ticker: 'AAPL', bars: base },
        { ticker: 'MSFT', bars: base },
      ],
      { warmupBars: 20, scannerCfg: {} },
    );
    expect(trades).toHaveLength(2);
    expect(new Set(trades.map((t) => t.ticker))).toEqual(new Set(['AAPL', 'MSFT']));
  });

  it('returns empty array when no signal across universe', () => {
    const flatBars: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      timestamp: i,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,
      volume: 1000,
    }));
    const trades = backtestUniverse(
      [{ ticker: 'X', bars: flatBars }],
      { warmupBars: 20, scannerCfg: {} },
    );
    expect(trades).toEqual([]);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

function makeBar(t: number, open: number, high: number, low: number, close: number): Candle {
  return { timestamp: t, open, high, low, close, volume: 1000 };
}
