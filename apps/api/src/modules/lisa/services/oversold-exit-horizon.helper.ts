/**
 * oversold-exit-horizon.helper.ts — « meilleur jour de sortie », POPULATION COMPLÈTE.
 *
 * v2 (21/07) — l'ancienne version lisait la trajectoire des closes verrouillés
 * (`position_close_decisions`) = GAGNANTES UNIQUEMENT → biais de survie qui a fait
 * successivement croire à un pic J+3 (18/06) puis J+6 (22/06). Le verdict sur
 * population complète (30/06, reconfirmé 21/07 : lock +0.64%/+1.20% vs J+10
 * −4.29%/−0.84%) : LE LOCK BAT TOUS LES HORIZONS. Cette v2 lit `paper_trades`
 * (TOUTES les entrées, perdantes incluses) : lock = pnl_pct réalisé des fermées,
 * J+N = fwd_return_{1,3,6,10}d stampés par le labeler (migration 0204).
 *
 * Pure compute, testable. MESURE SEULE — ne change rien au trading.
 */

export interface ExitHorizonFullPopRow {
  pnl_pct: number | string | null; // P&L réalisé (fermées) = sortie jour J (lock)
  status: string | null;
  fwd_return_1d: number | string | null;
  fwd_return_3d: number | string | null;
  fwd_return_6d: number | string | null;
  fwd_return_10d: number | string | null;
}

export type ExitHorizonKey = 'lock' | 'j1' | 'j3' | 'j6' | 'j10';

export interface ExitHorizonDay {
  label: string;
  key: ExitHorizonKey;
  avgPct: number | null;
  medPct: number | null;
  winPct: number | null;
  n: number;
}

export interface ExitHorizonShadow {
  n: number; // entrées totales considérées
  basis: 'full_population';
  days: ExitHorizonDay[];
  bestDayByMean: string | null;
  bestDayByMedian: string | null;
  lockAvgPct: number | null;
  bestHoldLabel: string | null; // meilleur jour de HOLD (hors lock)
  bestHoldAvgPct: number | null;
  upliftBestHoldVsLockPct: number | null; // bestHold − lock (moyenne) : >0 = tenir paierait
  minSampleForBest: number;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

function toNum(x: unknown): number | null {
  if (x == null) return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

/** `minSampleForBest` exclut les horizons à trop petit échantillon du « meilleur jour ». */
export function computeExitHorizonFullPopulation(
  rows: ExitHorizonFullPopRow[],
  minSampleForBest = 10,
): ExitHorizonShadow {
  const defs: Array<{ label: string; key: ExitHorizonKey; get: (r: ExitHorizonFullPopRow) => number | null }> = [
    { label: 'J (lock)', key: 'lock', get: (r) => (r.status !== 'open' ? toNum(r.pnl_pct) : null) },
    { label: 'J+1', key: 'j1', get: (r) => toNum(r.fwd_return_1d) },
    { label: 'J+3', key: 'j3', get: (r) => toNum(r.fwd_return_3d) },
    { label: 'J+6', key: 'j6', get: (r) => toNum(r.fwd_return_6d) },
    { label: 'J+10', key: 'j10', get: (r) => toNum(r.fwd_return_10d) },
  ];

  const days: ExitHorizonDay[] = defs.map((d) => {
    const vals = rows.map(d.get).filter((v): v is number => v != null);
    if (!vals.length) return { label: d.label, key: d.key, avgPct: null, medPct: null, winPct: null, n: 0 };
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const s = [...vals].sort((a, b) => a - b);
    const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    const win = (vals.filter((v) => v > 0).length / vals.length) * 100;
    return { label: d.label, key: d.key, avgPct: round1(avg), medPct: round1(med), winPct: Math.round(win), n: vals.length };
  });

  const eligible = days.filter((d) => d.n >= minSampleForBest);
  const byMean = eligible.filter((d) => d.avgPct != null).sort((a, b) => (b.avgPct as number) - (a.avgPct as number))[0];
  const byMed = eligible.filter((d) => d.medPct != null).sort((a, b) => (b.medPct as number) - (a.medPct as number))[0];
  const lock = days.find((d) => d.key === 'lock');
  const holdBest = eligible
    .filter((d) => d.key !== 'lock' && d.avgPct != null)
    .sort((a, b) => (b.avgPct as number) - (a.avgPct as number))[0];
  const uplift = lock?.avgPct != null && holdBest?.avgPct != null ? round1(holdBest.avgPct - lock.avgPct) : null;

  return {
    n: rows.length,
    basis: 'full_population',
    days,
    bestDayByMean: byMean?.label ?? null,
    bestDayByMedian: byMed?.label ?? null,
    lockAvgPct: lock?.avgPct ?? null,
    bestHoldLabel: holdBest?.label ?? null,
    bestHoldAvgPct: holdBest?.avgPct ?? null,
    upliftBestHoldVsLockPct: uplift,
    minSampleForBest,
  };
}
