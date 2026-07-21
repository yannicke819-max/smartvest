import { computeExitHorizonFullPopulation, ExitHorizonFullPopRow } from '../oversold-exit-horizon.helper';

describe('computeExitHorizonFullPopulation (v2 — population complète)', () => {
  it('lock = pnl des fermées ; J+N = fwd_return de TOUTES les entrées (perdantes incluses)', () => {
    const rows: ExitHorizonFullPopRow[] = [
      { pnl_pct: 1.5, status: 'closed', fwd_return_1d: 2, fwd_return_3d: -4, fwd_return_6d: null, fwd_return_10d: -8 },
      { pnl_pct: 1.7, status: 'closed', fwd_return_1d: -3, fwd_return_3d: -6, fwd_return_6d: null, fwd_return_10d: -2 },
      { pnl_pct: null, status: 'open', fwd_return_1d: 4, fwd_return_3d: null, fwd_return_6d: null, fwd_return_10d: null },
    ];
    const r = computeExitHorizonFullPopulation(rows, 1);
    expect(r.basis).toBe('full_population');
    const lock = r.days.find((d) => d.key === 'lock')!;
    expect(lock.n).toBe(2); // les open ne comptent pas dans le lock
    expect(lock.avgPct).toBe(1.6);
    const j1 = r.days.find((d) => d.key === 'j1')!;
    expect(j1.n).toBe(3); // TOUTES les entrées labellisées, open incluses
    expect(j1.avgPct).toBe(1); // (2 - 3 + 4) / 3
    const j10 = r.days.find((d) => d.key === 'j10')!;
    expect(j10.avgPct).toBe(-5); // (-8 - 2) / 2 → tenir perd
    expect(r.bestDayByMean).toBe('J (lock)');
    expect(r.upliftBestHoldVsLockPct).toBe(-0.6); // meilleur hold (J+1 +1.0) − lock (+1.6)
  });

  it('exclut les horizons sous minSampleForBest du « meilleur jour » (anti-bruit)', () => {
    const rows: ExitHorizonFullPopRow[] = [
      { pnl_pct: 1, status: 'closed', fwd_return_1d: 0.5, fwd_return_3d: null, fwd_return_6d: null, fwd_return_10d: 50 },
      { pnl_pct: 1, status: 'closed', fwd_return_1d: 0.5, fwd_return_3d: null, fwd_return_6d: null, fwd_return_10d: null },
    ];
    const r = computeExitHorizonFullPopulation(rows, 2);
    // J+10 n=1 < 2 → exclu malgré +50%
    expect(r.bestDayByMean).toBe('J (lock)');
  });

  it('gère table vide et valeurs non-finies sans crash', () => {
    expect(computeExitHorizonFullPopulation([]).n).toBe(0);
    const r = computeExitHorizonFullPopulation([
      { pnl_pct: 'abc' as unknown as number, status: 'closed', fwd_return_1d: null, fwd_return_3d: null, fwd_return_6d: null, fwd_return_10d: null },
    ]);
    expect(r.days.find((d) => d.key === 'lock')!.n).toBe(0);
    expect(r.bestDayByMean).toBeNull();
  });
});
