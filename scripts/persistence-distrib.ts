/**
 * Quick distrib des persistence_score sur les reject_persistence Thu+Fri.
 * → combien de candidats récupérés si on passe le seuil de 0.33 à 0.17.
 */
import { createClient } from '@supabase/supabase-js';
const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);

async function main() {
  const since = '2026-05-22T00:00:00Z';
  const until = '2026-05-24T00:00:00Z';

  // Tous les rejected_persistence sur la fenêtre
  const { data: rejected } = await sb
    .from('gainers_user_shadow_signals')
    .select('persistence_score, asset_class, sim_results')
    .gte('created_at', since)
    .lt('created_at', until)
    .eq('decision', 'reject_persistence');

  if (!rejected || rejected.length === 0) { console.log('no data'); return; }

  console.log(`Total reject_persistence : ${rejected.length}\n`);

  // Histogramme par tranche de persistence_score
  const buckets: Record<string, number> = {
    '0.00 (0/6)': 0,
    '0.17 (1/6)': 0,
    '0.33 (2/6)': 0,
    '0.50 (3/6)': 0,
    '0.67 (4/6)': 0,
    '>=0.67': 0,
    'null/n/a': 0,
  };
  for (const r of rejected) {
    const s = r.persistence_score;
    if (s === null || s === undefined) { buckets['null/n/a']++; continue; }
    const score = Number(s);
    if (score < 0.10) buckets['0.00 (0/6)']++;
    else if (score < 0.25) buckets['0.17 (1/6)']++;
    else if (score < 0.42) buckets['0.33 (2/6)']++;
    else if (score < 0.58) buckets['0.50 (3/6)']++;
    else if (score < 0.74) buckets['0.67 (4/6)']++;
    else buckets['>=0.67']++;
  }

  console.log('Distribution persistence_score chez les REJECTED :');
  for (const [k, v] of Object.entries(buckets)) {
    const pct = (v / rejected.length) * 100;
    console.log(`  ${k.padEnd(14)} ${v.toString().padStart(4)}  (${pct.toFixed(1)}%)`);
  }

  // Combien seraient sauvés si seuil = 0.17 vs 0.33 ?
  const savedAt017 = rejected.filter((r) => {
    const s = Number(r.persistence_score ?? 0);
    return s >= 0.10;  // tous ceux avec >= 1/6 (le seuil 0.17 inclut score=0.17)
  }).length;
  const savedAt0 = rejected.length; // unset complet

  console.log(`\nSI seuil passe de 0.33 (actuel) → 0.17 :  +${savedAt017} candidats sauvés (= ${(savedAt017/2).toFixed(0)}/jour)`);
  console.log(`SI seuil passe à 0 (unset complet)        : +${savedAt0} candidats sauvés (= ${(savedAt0/2).toFixed(0)}/jour)`);

  // Outcomes des candidats qui seraient sauvés à 0.17
  const wouldBeSaved = rejected.filter((r) => Number(r.persistence_score ?? 0) >= 0.10);
  const simsSaved = wouldBeSaved
    .map((r) => (r.sim_results as { baseline_60m?: { outcome?: string; pnl_pct?: number } } | null)?.baseline_60m)
    .filter((s): s is { outcome: string; pnl_pct: number } => !!s && typeof s.pnl_pct === 'number' && s.outcome !== 'NO_DATA');
  if (simsSaved.length > 0) {
    const tp = simsSaved.filter((s) => s.outcome === 'TP_HIT').length;
    const sl = simsSaved.filter((s) => s.outcome === 'SL_HIT').length;
    const tl = simsSaved.filter((s) => s.outcome === 'TIME_LIMIT').length;
    const wins = simsSaved.filter((s) => s.pnl_pct > 0).length;
    const winRate = (wins / simsSaved.length) * 100;
    const sumPnl = simsSaved.reduce((a, b) => a + b.pnl_pct, 0) * 100;
    console.log(`\nOutcomes simulés des candidats qui seraient sauvés (sim N=${simsSaved.length}):`);
    console.log(`  TP_HIT : ${tp}   SL_HIT : ${sl}   TIME : ${tl}`);
    console.log(`  winRate : ${winRate.toFixed(0)}%   sumPnl : ${sumPnl >= 0 ? '+' : ''}${sumPnl.toFixed(2)}%`);
  }

  // Par classe
  console.log(`\nPar classe (candidats sauvés à seuil 0.17) :`);
  const byClass: Record<string, number> = {};
  for (const r of wouldBeSaved) byClass[r.asset_class] = (byClass[r.asset_class] ?? 0) + 1;
  for (const [c, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(22)} +${n}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
