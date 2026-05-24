/**
 * Feature A/B Tuning — pure helper, no I/O.
 *
 * Miracle #4 : analyse statistique du PnL des derniers N jours, séparant
 * les jours où chaque flag était ON vs OFF. Output : ranking des features
 * par contribution marginale au PnL.
 *
 * Pas un vrai A/B test randomisé (on n'a pas les conditions). C'est une
 * corrélation observationnelle qui aide à voir quelles features valent
 * la peine d'être activées vs désactivées.
 */

export interface DailySnapshot {
  date: string;       // YYYY-MM-DD
  pnl_usd: number;
  flags: Record<string, boolean>;
  n_closes: number;
}

export interface FeatureContribution {
  flag_name: string;
  n_days_on: number;
  n_days_off: number;
  mean_pnl_on: number;
  mean_pnl_off: number;
  delta_pnl: number;       // mean_pnl_on - mean_pnl_off (positif = la feature aide)
  total_pnl_on: number;
  total_pnl_off: number;
  recommendation: 'KEEP_ON' | 'KEEP_OFF' | 'TOGGLE_OFF' | 'INCONCLUSIVE';
}

/**
 * Compute marginal contribution of each feature flag over the snapshot window.
 *
 * Recommendation logic :
 *   - n_days_on < 3 OR n_days_off < 3 → INCONCLUSIVE (sample trop petit)
 *   - delta_pnl > +$5/jour ET feature ON → KEEP_ON
 *   - delta_pnl < -$5/jour ET feature ON → TOGGLE_OFF (la feature détruit valeur)
 *   - sinon → INCONCLUSIVE
 */
export function computeFeatureContributions(
  snapshots: DailySnapshot[],
  minDelta = 5.0,
): FeatureContribution[] {
  if (snapshots.length === 0) return [];
  // Collect all flag names seen
  const allFlags = new Set<string>();
  for (const s of snapshots) for (const k of Object.keys(s.flags)) allFlags.add(k);

  const out: FeatureContribution[] = [];
  for (const flag of allFlags) {
    const onDays = snapshots.filter((s) => s.flags[flag] === true);
    const offDays = snapshots.filter((s) => s.flags[flag] === false);
    const n_on = onDays.length;
    const n_off = offDays.length;
    const sum_on = onDays.reduce((a, s) => a + s.pnl_usd, 0);
    const sum_off = offDays.reduce((a, s) => a + s.pnl_usd, 0);
    const mean_on = n_on > 0 ? sum_on / n_on : 0;
    const mean_off = n_off > 0 ? sum_off / n_off : 0;
    const delta = mean_on - mean_off;

    let recommendation: FeatureContribution['recommendation'];
    if (n_on < 3 || n_off < 3) {
      recommendation = 'INCONCLUSIVE';
    } else if (delta > minDelta) {
      recommendation = 'KEEP_ON';
    } else if (delta < -minDelta) {
      recommendation = 'TOGGLE_OFF';
    } else {
      recommendation = 'INCONCLUSIVE';
    }

    out.push({
      flag_name: flag,
      n_days_on: n_on,
      n_days_off: n_off,
      mean_pnl_on: Math.round(mean_on * 100) / 100,
      mean_pnl_off: Math.round(mean_off * 100) / 100,
      delta_pnl: Math.round(delta * 100) / 100,
      total_pnl_on: Math.round(sum_on * 100) / 100,
      total_pnl_off: Math.round(sum_off * 100) / 100,
      recommendation,
    });
  }
  // Sort by absolute delta DESC (les plus discriminants en haut)
  return out.sort((a, b) => Math.abs(b.delta_pnl) - Math.abs(a.delta_pnl));
}

/**
 * Build une narrative humaine du ranking : "TOP : conviction_sizing (+$25/jour),
 * BOTTOM : reverse_momentum (-$30/jour)..."
 */
export function buildNarrative(contributions: FeatureContribution[]): string {
  if (contributions.length === 0) return 'Aucune donnée snapshot encore disponible.';
  const actionable = contributions.filter((c) => c.recommendation !== 'INCONCLUSIVE');
  if (actionable.length === 0) {
    return `${contributions.length} features observées, mais sample size insuffisant (< 3 jours ON ou OFF pour chacune). Continue à collecter.`;
  }
  const lines: string[] = [];
  const wins = actionable.filter((c) => c.recommendation === 'KEEP_ON');
  const losses = actionable.filter((c) => c.recommendation === 'TOGGLE_OFF');
  if (wins.length > 0) {
    lines.push('FEATURES QUI APPORTENT :');
    for (const w of wins) {
      const sign = w.delta_pnl >= 0 ? '+' : '';
      lines.push(`  ✓ ${w.flag_name} : ${sign}$${w.delta_pnl.toFixed(2)}/jour (${w.n_days_on} jours ON vs ${w.n_days_off} OFF)`);
    }
  }
  if (losses.length > 0) {
    lines.push('FEATURES À RECONSIDÉRER :');
    for (const l of losses) {
      lines.push(`  ✗ ${l.flag_name} : ${l.delta_pnl.toFixed(2)}$/jour ${l.n_days_on} jours ON vs ${l.n_days_off} OFF — TOGGLE_OFF recommandé`);
    }
  }
  return lines.join('\n');
}
