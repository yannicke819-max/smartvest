/**
 * P9 — Loi empirique (réponse littérale à la demande user) :
 *   « pour chaque bucket persistance, P(win) observée + courbe fittée »
 *
 * Pure : groupe les trades par persistenceCount (ex "4/6"), calcule
 * P(win) observée par bucket + IC Wilson 95%, retourne la table que
 * l'endpoint et le dashboard UI consomment.
 */

import { wilsonInterval } from './logistic-regression';

export interface TradeOutcome {
  /** Format "X/Y" — X positifs / Y dispos ; ex "4/6". */
  persistenceCount: string;
  /** Outcome : 1 = pnl_pct > 0 au close, 0 sinon. */
  outcomeLabel: 0 | 1;
  /** PnL réalisé (%) — utilisé pour calculer avgPnlPct par bucket. */
  pnlPct: number;
}

export interface BucketStat {
  /** Bucket clé (e.g. "4/6"). */
  persistenceCount: string;
  /** Nombre de trades dans ce bucket. */
  n: number;
  /** Wins observés. */
  wins: number;
  /** P(win) observée = wins/n. */
  pWinObserved: number;
  /** PnL moyen (%) sur ce bucket. */
  avgPnlPct: number;
  /** Intervalle de confiance Wilson 95% pour pWin. */
  ciLow: number;
  ciHigh: number;
  /** True si n >= minSample, sinon le caller peut choisir d'ignorer. */
  sufficient: boolean;
}

/**
 * Calcule la table empirique. Retourne les buckets triés par persistenceCount
 * croissant (0/6, 1/6, ..., 6/6). Buckets vides absents.
 *
 * minSample : seuil de trades requis pour considérer un bucket "fiable".
 * Default 20 (cohérent avec spec ticket).
 */
export function computeEmpiricalLaw(
  trades: TradeOutcome[],
  minSample = 20,
): BucketStat[] {
  const buckets = new Map<string, { wins: number; n: number; pnlSum: number }>();
  for (const t of trades) {
    const k = t.persistenceCount;
    const entry = buckets.get(k) ?? { wins: 0, n: 0, pnlSum: 0 };
    entry.n++;
    entry.wins += t.outcomeLabel === 1 ? 1 : 0;
    entry.pnlSum += Number.isFinite(t.pnlPct) ? t.pnlPct : 0;
    buckets.set(k, entry);
  }

  const stats: BucketStat[] = [];
  for (const [persistenceCount, entry] of buckets.entries()) {
    const pWinObserved = entry.n > 0 ? entry.wins / entry.n : 0;
    const avgPnlPct = entry.n > 0 ? entry.pnlSum / entry.n : 0;
    const ci = wilsonInterval(entry.wins, entry.n);
    stats.push({
      persistenceCount,
      n: entry.n,
      wins: entry.wins,
      pWinObserved,
      avgPnlPct,
      ciLow: ci.lower,
      ciHigh: ci.upper,
      sufficient: entry.n >= minSample,
    });
  }

  // Tri "X/Y" par X (positiveCount), puis Y (denominator)
  stats.sort((a, b) => {
    const pa = parsePos(a.persistenceCount);
    const pb = parsePos(b.persistenceCount);
    if (pa.pos !== pb.pos) return pa.pos - pb.pos;
    return pa.den - pb.den;
  });

  return stats;
}

function parsePos(key: string): { pos: number; den: number } {
  const m = key.match(/^(\d+)\/(\d+)$/);
  if (!m) return { pos: -1, den: -1 };
  return { pos: parseInt(m[1], 10), den: parseInt(m[2], 10) };
}
