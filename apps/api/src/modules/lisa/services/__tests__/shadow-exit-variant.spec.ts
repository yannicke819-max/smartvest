/**
 * Migration 0150 — Shadow A/B variante entrée pullback.
 *
 * simulateVariant(row) doit :
 *   - attendre un pullback de pullback_pct sous entry_price dans la fenêtre,
 *   - entrer à ce close avec SL élargi (sl_pct) + TP (tp_pct),
 *   - rejouer le moteur BLOC4 (applyTick) identique au live,
 *   - retourner 'no_entry' si la fenêtre s'écoule sans pullback,
 *   - retourner 'pending' si entrée touchée mais exit non résolu (< time-limit).
 *
 * On instancie via Object.create (DI lourd) + stub fetchCandles.
 */

import { ShadowExitSimulatorService } from '../shadow-exit-simulator.service';

interface Svc {
  variantPullbackPct: number;
  variantWindowMin: number;
  variantSlPct: number;
  variantTpPct: number;
  fetchCandles: (row: unknown, count: number) => Promise<Array<{ close: number }> | null>;
  simulateVariant: (row: unknown) => Promise<unknown>;
}

function makeSvc(candles: Array<{ close: number }> | null): Svc {
  const svc = Object.create(ShadowExitSimulatorService.prototype) as unknown as Svc;
  svc.variantPullbackPct = 0.015;
  svc.variantWindowMin = 30;
  svc.variantSlPct = 0.025;
  svc.variantTpPct = 0.03;
  svc.fetchCandles = async () => candles;
  return svc;
}

function row(createdMinAgo: number) {
  return {
    id: 'sig-1',
    symbol: 'AAPL.US',
    exchange: 'US',
    asset_class: 'equity' as const,
    entry_price: 100,
    entry_path_eff: 0.6,
    tp_price: 103,
    sl_price: 98.5,
    created_at: new Date(Date.now() - createdMinAgo * 60_000).toISOString(),
  };
}

describe('Migration 0151 — variant_exit_grid', () => {
  it('grille TP/SL calculée sur la même entrée pullback', async () => {
    // entrée 98.4 (idx1). candle idx2=102.
    // tp3% → 98.4*1.03=101.35 ; 102>=101.35 → TP_FULL +0.03.
    // tp5% → 98.4*1.05=103.32 ; 102<103.32 → TIME_LIMIT pnl=(102-98.4)/98.4.
    const candles = [{ close: 99.5 }, { close: 98.4 }, { close: 102 }];
    const svc = makeSvc(candles);
    const v = (await svc.simulateVariant(row(300))) as {
      exitGrid: Array<{ tp_pct: number; sl_pct: number; pnl_pct: number; exit_reason: string }>;
    };
    expect(Array.isArray(v.exitGrid)).toBe(true);
    expect(v.exitGrid.length).toBe(5);
    const tp3 = v.exitGrid.find((g) => g.tp_pct === 0.03)!;
    expect(tp3.exit_reason).toBe('TP_FULL');
    expect(tp3.pnl_pct).toBeCloseTo(0.03, 5);
    const tp20 = v.exitGrid.find((g) => g.tp_pct === 0.2)!;
    expect(tp20.exit_reason).toBe('TIME_LIMIT');
    expect(tp20.pnl_pct).toBeCloseTo((102 - 98.4) / 98.4, 5);
  });

  it('grille : SL serré touché avant un TP large → loss borné au SL', async () => {
    // entrée 98.0 (idx0, <=98.5). idx1=95 → -3.06% < tous les SL (2.5/3%) → SL pour tous.
    const candles = [{ close: 98.0 }, { close: 95 }];
    const svc = makeSvc(candles);
    const v = (await svc.simulateVariant(row(300))) as {
      exitGrid: Array<{ tp_pct: number; sl_pct: number; pnl_pct: number; exit_reason: string }>;
    };
    for (const g of v.exitGrid) {
      expect(g.exit_reason).toBe('SL');
      expect(g.pnl_pct).toBeCloseTo(-g.sl_pct, 5);
    }
  });
});

describe('Migration 0150 — simulateVariant', () => {
  it('pullback touché puis TP → win, entrée au creux, SL à 2.5%', async () => {
    // trigger pullback = 100*(1-0.015) = 98.5. idx1=98.4 touche, puis idx2=102 >= TP(98.4*1.03=101.35).
    const candles = [{ close: 99.5 }, { close: 98.4 }, { close: 102 }];
    const svc = makeSvc(candles);
    const v = (await svc.simulateVariant(row(300))) as {
      entryPrice: number; entryOffsetMin: number; exitReason: string; pnlPct: number;
    };
    expect(v.entryPrice).toBe(98.4);
    expect(v.entryOffsetMin).toBe(2); // idx1 → minute 2
    expect(v.exitReason).toBe('TP_FULL');
    expect(v.pnlPct).toBeCloseTo((102 - 98.4) / 98.4, 5);
  });

  it('pullback puis SL élargi (2.5%) touché → loss', async () => {
    // entrée 98.4, SL = 98.4*0.975 = 95.94. idx2=95 <= SL.
    const candles = [{ close: 98.0 }, { close: 95 }];
    const svc = makeSvc(candles);
    const v = (await svc.simulateVariant(row(300))) as { exitReason: string; pnlPct: number };
    expect(v.exitReason).toBe('SL');
    expect(v.pnlPct).toBeLessThan(0);
  });

  it('aucun pullback + fenêtre écoulée → no_entry', async () => {
    const candles = Array.from({ length: 35 }, () => ({ close: 100.5 })); // jamais sous 98.5
    const svc = makeSvc(candles);
    const v = await svc.simulateVariant(row(60)); // age 60 > window 30
    expect(v).toBe('no_entry');
  });

  it('pullback touché mais exit non résolu et < time-limit → pending', async () => {
    const candles = [{ close: 98.0 }, { close: 99 }, { close: 99.5 }]; // entrée idx0, pas de TP/SL
    const svc = makeSvc(candles);
    const v = await svc.simulateVariant(row(10)); // hold court, pas de time-limit
    expect(v).toBe('pending');
  });

  it('trop jeune (fenêtre non écoulée, pas de pullback) → null', async () => {
    const candles = [{ close: 100.2 }, { close: 100.1 }];
    const svc = makeSvc(candles);
    const v = await svc.simulateVariant(row(8)); // age 8 < window 30
    expect(v).toBeNull();
  });

  it('ticker non-couvert + fenêtre écoulée → skip (anti-famine, candles inatteignables)', async () => {
    const svc = makeSvc(null); // fetchCandles renvoie null (blacklist/suffixe absent)
    const v = await svc.simulateVariant(row(300)); // age 300 >= window 30
    expect(v).toBe('skip');
  });

  it('ticker non-couvert mais trop jeune → null (échec transitoire, on réessaie)', async () => {
    const svc = makeSvc(null);
    const v = await svc.simulateVariant(row(8)); // age 8 < window 30
    expect(v).toBeNull();
  });
});
