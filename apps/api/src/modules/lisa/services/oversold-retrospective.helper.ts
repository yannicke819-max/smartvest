/**
 * Générateur DÉTERMINISTE de lessons oversold (pas de LLM).
 *
 * Le mode oversold est une stratégie mean-reversion déterministe → ses lessons
 * doivent l'être aussi (zéro coût LLM, zéro Gemini, reproductible). On agrège les
 * décisions de close ARRIVÉES à J+10 (contrefactuel finalisé) et on en tire 1-2
 * leçons actionnables par région :
 *   - EXIT_TIMING_* : le verrou +1,5% sort-il trop tôt ? (held_better vs close_better)
 *   - HEALTH_SUMMARY : win rate + P&L moyen de la fenêtre.
 *
 * Pure function → testable sans DB. La persistance/dédup vit dans le service.
 */

export interface OversoldCloseRow {
  pnlPct: number | null;
  pnlUsd: number | null;
  deadlineVerdict: string | null; // 'HELD_BETTER' | 'CLOSE_BETTER' | 'NEUTRAL'
  pnlIfHeldToDeadlinePct: number | null;
  bestDayLabel: string | null; // 'J+1' | 'J+3' | 'J+6' | 'J+10'
  bestDayPnlPct: number | null;
}

export interface OversoldLessonCandidate {
  lessonKind: string;
  lessonText: string;
  scope: string;
  confidence: number;
  sampleSize: number;
  winRateObserved: number | null;
  avgPnlUsd: number | null;
  payload: Record<string, unknown>;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function toNum(v: unknown): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

/**
 * Construit les lessons oversold à partir d'un lot de closes finalisés (J+10).
 * Renvoie [] tant que le sample est sous le minimum (anti-bruit statistique).
 */
export function buildOversoldLessons(
  rows: OversoldCloseRow[],
  opts: { region: string; scope: string; minSample?: number },
): OversoldLessonCandidate[] {
  const minSample = opts.minSample ?? 5;
  const n = rows.length;
  if (n < minSample) return [];

  const reg = opts.region;
  const pnls = rows.map((r) => toNum(r.pnlPct)).filter((v): v is number => v != null);
  const pnlsUsd = rows.map((r) => toNum(r.pnlUsd)).filter((v): v is number => v != null);
  const wins = pnls.filter((v) => v > 0).length;
  const winRate = pnls.length ? (wins / pnls.length) * 100 : null;
  const avgPnlPct = pnls.length ? mean(pnls) : null;
  const avgPnlUsd = pnlsUsd.length ? mean(pnlsUsd) : null;

  const heldBetter = rows.filter((r) => r.deadlineVerdict === 'HELD_BETTER').length;
  const closeBetter = rows.filter((r) => r.deadlineVerdict === 'CLOSE_BETTER').length;
  const neutral = n - heldBetter - closeBetter;
  const heldPct = (heldBetter / n) * 100;
  const closePct = (closeBetter / n) * 100;

  // Give-up = combien tenir jusqu'à J+10 aurait ajouté vs la sortie réelle.
  const giveUps = rows
    .map((r) => {
      const h = toNum(r.pnlIfHeldToDeadlinePct);
      const c = toNum(r.pnlPct);
      return h != null && c != null ? h - c : null;
    })
    .filter((v): v is number => v != null);
  const avgGiveUp = giveUps.length ? mean(giveUps) : 0;

  // Distribution du meilleur jour (mode = plus fréquent).
  const bestDist: Record<string, number> = {};
  for (const r of rows) if (r.bestDayLabel) bestDist[r.bestDayLabel] = (bestDist[r.bestDayLabel] ?? 0) + 1;
  const modeBestDay = Object.entries(bestDist).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'J+10';

  const confidence = round2(clamp(0.5 + 0.08 * Math.log2(n / minSample + 1), 0.5, 0.9));
  const fmtPct = (v: number | null): string => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
  const fmtUsd = (v: number | null): string => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}$${v.toFixed(0)}`);

  const basePayload: Record<string, unknown> = {
    region: reg,
    n,
    win_rate: winRate != null ? round2(winRate) : null,
    avg_pnl_pct: avgPnlPct != null ? round2(avgPnlPct) : null,
    avg_pnl_usd: avgPnlUsd != null ? round2(avgPnlUsd) : null,
    held_better: heldBetter,
    close_better: closeBetter,
    neutral,
    avg_give_up_pct: round2(avgGiveUp),
    mode_best_day: modeBestDay,
    best_day_distribution: bestDist,
  };

  const out: OversoldLessonCandidate[] = [];

  // 1. EXIT TIMING — le verrou +1,5% sort-il trop tôt ?
  if (heldPct >= 50 && avgGiveUp >= 0.5) {
    out.push({
      lessonKind: 'EXIT_TIMING_HOLD_LONGER',
      lessonText: `Oversold ${reg} : sur ${n} sorties arrivées à J+10, ${heldBetter} (${heldPct.toFixed(0)}%) auraient gagné davantage en tenant — en moyenne ${fmtPct(avgGiveUp)} laissés sur la table par trade, meilleur jour le plus fréquent ${modeBestDay}. Le verrou +1,5% sort trop tôt → envisager d'étendre le hold vers ${modeBestDay}.`,
      scope: opts.scope,
      confidence,
      sampleSize: n,
      winRateObserved: winRate,
      avgPnlUsd,
      payload: { ...basePayload, signal: 'hold_longer' },
    });
  } else if (closePct >= 50 && avgGiveUp <= 0) {
    out.push({
      lessonKind: 'EXIT_TIMING_LOCK_OK',
      lessonText: `Oversold ${reg} : sur ${n} sorties, tenir jusqu'à J+10 aurait dégradé le résultat (${closeBetter} close_better, give-up moyen ${fmtPct(avgGiveUp)}). Le verrou +1,5% capture bien le rebond → conserver une sortie courte.`,
      scope: opts.scope,
      confidence,
      sampleSize: n,
      winRateObserved: winRate,
      avgPnlUsd,
      payload: { ...basePayload, signal: 'lock_ok' },
    });
  } else {
    out.push({
      lessonKind: 'EXIT_TIMING_MIXED',
      lessonText: `Oversold ${reg} : ${n} sorties, signal mitigé (held_better ${heldPct.toFixed(0)}% / close_better ${closePct.toFixed(0)}%, give-up moyen ${fmtPct(avgGiveUp)}). Pas d'edge clair pour étendre ou raccourcir le hold — garder le verrou actuel et ré-évaluer avec plus de données.`,
      scope: opts.scope,
      confidence: Math.min(confidence, 0.6),
      sampleSize: n,
      winRateObserved: winRate,
      avgPnlUsd,
      payload: { ...basePayload, signal: 'mixed' },
    });
  }

  // 2. HEALTH — synthèse win rate / P&L de la fenêtre.
  const healthNote =
    winRate != null && winRate < 40
      ? 'Sous la cible mean-reversion — surveiller la bande de drop et le régime VIX.'
      : "Conforme à l'edge mean-reversion attendu.";
  out.push({
    lessonKind: 'HEALTH_SUMMARY',
    lessonText: `Oversold ${reg} : ${n} trades clos sur la fenêtre, win rate ${winRate != null ? winRate.toFixed(0) : 'n/a'}%, P&L moyen ${fmtUsd(avgPnlUsd)}/trade (${fmtPct(avgPnlPct)}). ${healthNote}`,
    scope: opts.scope,
    confidence,
    sampleSize: n,
    winRateObserved: winRate,
    avgPnlUsd,
    payload: { ...basePayload, signal: 'health' },
  });

  return out;
}
