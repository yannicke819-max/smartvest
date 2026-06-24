/**
 * oversold-exit-horizon.helper.ts — SHADOW « meilleur jour de sortie ».
 *
 * Pure compute, testable. Pour les positions oversold clôturées par le gain-picker
 * (lock +1.5%), compare le P&L réalisé (jour J) à ce qu'un exit à chaque horizon
 * J+1 / J+3 / J+6 / J+10 aurait donné, à partir de la trajectoire RÉELLE déjà
 * labellisée dans `position_close_decisions` (price_j1/j3/j6/j10 vs entry_price).
 *
 * MESURE SEULE — ne change rien au trading. Sert à décider (sur données live, biais
 * de survie assumé) s'il faut allonger l'horizon de sortie (ex US → J+6) ou garder
 * le lock (ex EU, bimodal → la moyenne du hold est plombée par les effondrements).
 */

export interface ExitHorizonRow {
  pnl_pct: number | string | null; // P&L réalisé à la sortie (lock) = jour J
  entry_price: number | string | null;
  price_j1: number | string | null;
  price_j3: number | string | null;
  price_j6: number | string | null;
  price_j10: number | string | null;
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
  n: number; // lignes avec trajectoire (price_j1 non null)
  days: ExitHorizonDay[];
  bestDayByMean: string | null;
  bestDayByMedian: string | null;
  lockAvgPct: number | null;
  j6AvgPct: number | null;
  upliftJ6VsLockPct: number | null; // j6 - lock (moyenne) : >0 = tenir paie
  minSampleForBest: number;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

function toNum(x: unknown): number | null {
  if (x == null) return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

/**
 * Calcule la table par horizon. `minSampleForBest` exclut les jours à trop petit
 * échantillon du choix du « meilleur jour » (ex US J+10 n=1 = bruit).
 */
export function computeExitHorizonShadow(rows: ExitHorizonRow[], minSampleForBest = 3): ExitHorizonShadow {
  const pj = (r: ExitHorizonRow, field: 'price_j1' | 'price_j3' | 'price_j6' | 'price_j10'): number | null => {
    const px = toNum(r[field]);
    const e = toNum(r.entry_price);
    return px != null && e != null && e > 0 ? (px / e - 1) * 100 : null;
  };
  const defs: Array<{ label: string; key: ExitHorizonKey; get: (r: ExitHorizonRow) => number | null }> = [
    { label: 'J (lock)', key: 'lock', get: (r) => toNum(r.pnl_pct) },
    { label: 'J+1', key: 'j1', get: (r) => pj(r, 'price_j1') },
    { label: 'J+3', key: 'j3', get: (r) => pj(r, 'price_j3') },
    { label: 'J+6', key: 'j6', get: (r) => pj(r, 'price_j6') },
    { label: 'J+10', key: 'j10', get: (r) => pj(r, 'price_j10') },
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
  const j6 = days.find((d) => d.key === 'j6');
  const uplift = lock?.avgPct != null && j6?.avgPct != null ? round1(j6.avgPct - lock.avgPct) : null;

  return {
    n: rows.length,
    days,
    bestDayByMean: byMean?.label ?? null,
    bestDayByMedian: byMed?.label ?? null,
    lockAvgPct: lock?.avgPct ?? null,
    j6AvgPct: j6?.avgPct ?? null,
    upliftJ6VsLockPct: uplift,
    minSampleForBest,
  };
}
