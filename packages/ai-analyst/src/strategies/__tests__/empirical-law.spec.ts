/**
 * P9 — Tests bucketing empirique.
 */
import { computeEmpiricalLaw } from '../empirical-law';

describe('computeEmpiricalLaw', () => {
  it('groups trades by persistenceCount', () => {
    const trades = [
      { persistenceCount: '6/6', outcomeLabel: 1 as const, pnlPct: 3.5 },
      { persistenceCount: '6/6', outcomeLabel: 1 as const, pnlPct: 4.0 },
      { persistenceCount: '6/6', outcomeLabel: 0 as const, pnlPct: -2.0 },
      { persistenceCount: '4/6', outcomeLabel: 1 as const, pnlPct: 2.0 },
      { persistenceCount: '4/6', outcomeLabel: 0 as const, pnlPct: -1.5 },
    ];
    const result = computeEmpiricalLaw(trades, 1);
    const b66 = result.find((b) => b.persistenceCount === '6/6');
    expect(b66?.n).toBe(3);
    expect(b66?.wins).toBe(2);
    expect(b66?.pWinObserved).toBeCloseTo(2 / 3);
    expect(b66?.avgPnlPct).toBeCloseTo((3.5 + 4 - 2) / 3);

    const b46 = result.find((b) => b.persistenceCount === '4/6');
    expect(b46?.n).toBe(2);
    expect(b46?.wins).toBe(1);
    expect(b46?.pWinObserved).toBe(0.5);
  });

  it('marks sufficient based on minSample threshold', () => {
    const trades = Array.from({ length: 25 }, (_, i) => ({
      persistenceCount: '6/6',
      outcomeLabel: (i % 2) as 0 | 1,
      pnlPct: i * 0.1,
    }));
    const result = computeEmpiricalLaw(trades, 20);
    expect(result[0].sufficient).toBe(true);

    const small = computeEmpiricalLaw(trades.slice(0, 5), 20);
    expect(small[0].sufficient).toBe(false);
  });

  it('returns Wilson CI for each bucket', () => {
    const trades = [
      { persistenceCount: '6/6', outcomeLabel: 1 as const, pnlPct: 3 },
      { persistenceCount: '6/6', outcomeLabel: 1 as const, pnlPct: 3 },
      { persistenceCount: '6/6', outcomeLabel: 1 as const, pnlPct: 3 },
      { persistenceCount: '6/6', outcomeLabel: 1 as const, pnlPct: 3 },
    ];
    const r = computeEmpiricalLaw(trades, 1);
    expect(r[0].pWinObserved).toBe(1);
    // Wilson lower < 1 strict (incertitude résiduelle même à 4/4)
    expect(r[0].ciLow).toBeLessThan(1);
    expect(r[0].ciHigh).toBeLessThanOrEqual(1);
  });

  it('returns sorted buckets ascending by positiveCount/denominator', () => {
    const trades = [
      { persistenceCount: '6/6', outcomeLabel: 1 as const, pnlPct: 3 },
      { persistenceCount: '0/6', outcomeLabel: 0 as const, pnlPct: -1 },
      { persistenceCount: '3/6', outcomeLabel: 0 as const, pnlPct: 0 },
      { persistenceCount: '5/6', outcomeLabel: 1 as const, pnlPct: 2 },
    ];
    const r = computeEmpiricalLaw(trades, 1);
    expect(r.map((b) => b.persistenceCount)).toEqual(['0/6', '3/6', '5/6', '6/6']);
  });

  it('empty trades → empty result', () => {
    expect(computeEmpiricalLaw([], 20)).toEqual([]);
  });

  it('property: pWin tend à croître avec persistenceCount sur signal calibré', () => {
    // Génère synthetic dataset où pWin observée monte avec persistenceCount
    const trades: Array<{ persistenceCount: string; outcomeLabel: 0 | 1; pnlPct: number }> = [];
    const buckets: Array<[string, number]> = [
      ['0/6', 0.13], ['1/6', 0.27], ['2/6', 0.40], ['3/6', 0.50],
      ['4/6', 0.61], ['5/6', 0.70], ['6/6', 0.78],
    ];
    for (const [key, pTarget] of buckets) {
      for (let i = 0; i < 50; i++) {
        const win = i / 50 < pTarget ? 1 : 0;
        trades.push({
          persistenceCount: key,
          outcomeLabel: win as 0 | 1,
          pnlPct: win === 1 ? 2 : -1,
        });
      }
    }
    const r = computeEmpiricalLaw(trades, 1);
    // Vérifie monotonie : pWin(0/6) < pWin(3/6) < pWin(6/6)
    const p0 = r.find((b) => b.persistenceCount === '0/6')!.pWinObserved;
    const p3 = r.find((b) => b.persistenceCount === '3/6')!.pWinObserved;
    const p6 = r.find((b) => b.persistenceCount === '6/6')!.pWinObserved;
    expect(p0).toBeLessThan(p3);
    expect(p3).toBeLessThan(p6);
  });
});
