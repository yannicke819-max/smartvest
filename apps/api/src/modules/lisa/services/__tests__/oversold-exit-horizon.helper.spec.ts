import { computeExitHorizonShadow, ExitHorizonRow } from '../oversold-exit-horizon.helper';

describe('computeExitHorizonShadow', () => {
  it('calcule moyenne/médiane/%gagnants par horizon depuis price_jN vs entry', () => {
    const rows: ExitHorizonRow[] = [
      { pnl_pct: 1.5, entry_price: 100, price_j1: 105, price_j3: 110, price_j6: 120, price_j10: null },
      { pnl_pct: 2.0, entry_price: 100, price_j1: 102, price_j3: 100, price_j6: 90, price_j10: null },
    ];
    const r = computeExitHorizonShadow(rows, 1);
    const j6 = r.days.find((d) => d.key === 'j6')!;
    expect(j6.n).toBe(2);
    expect(j6.avgPct).toBe(5); // (+20% + -10%) / 2
    expect(j6.winPct).toBe(50);
    const lock = r.days.find((d) => d.key === 'lock')!;
    expect(lock.avgPct).toBe(1.8); // (1.5 + 2.0)/2
    expect(r.upliftJ6VsLockPct).toBe(3.2); // 5 - 1.8
  });

  it('exclut les jours sous minSampleForBest du « meilleur jour » (anti-bruit n=1)', () => {
    const rows: ExitHorizonRow[] = [
      { pnl_pct: 1.5, entry_price: 100, price_j1: 104, price_j3: 106, price_j6: 108, price_j10: 200 }, // J+10 énorme mais n=1
      { pnl_pct: 1.5, entry_price: 100, price_j1: 103, price_j3: 107, price_j6: 110, price_j10: null },
    ];
    const r = computeExitHorizonShadow(rows, 2);
    // J+10 n=1 < 2 → exclu malgré sa moyenne +100%
    expect(r.bestDayByMean).not.toBe('J+10');
    expect(r.bestDayByMean).toBe('J+6'); // meilleur parmi les jours à n>=2
  });

  it('gère valeurs nulles / entry invalide → champ null, pas de crash', () => {
    const rows: ExitHorizonRow[] = [
      { pnl_pct: null, entry_price: 0, price_j1: 50, price_j3: null, price_j6: null, price_j10: null },
    ];
    const r = computeExitHorizonShadow(rows);
    expect(r.n).toBe(1);
    expect(r.days.find((d) => d.key === 'j1')!.n).toBe(0); // entry=0 → exclu
    expect(r.days.find((d) => d.key === 'lock')!.n).toBe(0); // pnl null → exclu
  });

  it('liste vide → tout null, pas de crash', () => {
    const r = computeExitHorizonShadow([]);
    expect(r.n).toBe(0);
    expect(r.bestDayByMean).toBeNull();
    expect(r.days).toHaveLength(5);
  });
});
