/**
 * 1. UPDATE lisa_session_configs SET gainers_min_persistence_score = 0
 *    sur TOUS les portfolios (champ n'affecte que mode gainers).
 * 2. Distribution path_eff chez les rejected pour décider du sort de ce gate.
 */
import { createClient } from '@supabase/supabase-js';
const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);

async function main() {
  // ============ STEP 1 : unset persistence ============
  console.log('=== STEP 1 : Unset gainers_min_persistence_score ===\n');

  // Before
  const { data: before } = await sb
    .from('lisa_session_configs')
    .select('portfolio_id, strategy_mode, gainers_min_persistence_score');
  console.log('AVANT :');
  for (const c of before ?? []) {
    console.log(`  ${c.portfolio_id.slice(0, 8)}  mode=${c.strategy_mode ?? 'null'}  persistence=${c.gainers_min_persistence_score}`);
  }

  // Update
  const { error: upErr, count } = await sb
    .from('lisa_session_configs')
    .update({ gainers_min_persistence_score: 0 }, { count: 'exact' })
    .neq('portfolio_id', '00000000-0000-0000-0000-000000000000');
  if (upErr) { console.error('UPDATE failed:', upErr.message); process.exit(1); }
  console.log(`\n🚀 UPDATE OK : ${count ?? '?'} rows mis à 0`);

  // After
  const { data: after } = await sb
    .from('lisa_session_configs')
    .select('portfolio_id, gainers_min_persistence_score');
  console.log('\nAPRES :');
  for (const c of after ?? []) {
    console.log(`  ${c.portfolio_id.slice(0, 8)}  persistence=${c.gainers_min_persistence_score}`);
  }

  // ============ STEP 2 : path_eff distribution ============
  console.log('\n\n=== STEP 2 : Distribution path_eff chez les rejected ===\n');

  const since = '2026-05-22T00:00:00Z';
  const until = '2026-05-24T00:00:00Z';
  const { data: rejected } = await sb
    .from('gainers_user_shadow_signals')
    .select('path_eff, asset_class, sim_results')
    .gte('created_at', since)
    .lt('created_at', until)
    .eq('decision', 'reject_path_eff');
  if (!rejected) { console.log('no data'); return; }

  console.log(`Total reject_path_eff : ${rejected.length}\n`);

  const buckets: Array<[string, (s: number) => boolean]> = [
    ['0.00-0.10 (très choppy)', (s) => s < 0.10],
    ['0.10-0.20',                (s) => s >= 0.10 && s < 0.20],
    ['0.20-0.30',                (s) => s >= 0.20 && s < 0.30],
    ['0.30-0.40 (borderline)',   (s) => s >= 0.30 && s < 0.40],
    ['0.40-0.50 (seuil US=0.4)', (s) => s >= 0.40 && s < 0.50],
    ['>=0.50',                   (s) => s >= 0.50],
  ];

  type SimGrid = { outcome?: string; pnl_pct?: number };
  for (const [label, pred] of buckets) {
    const inBucket = rejected.filter((r) => pred(Number(r.path_eff ?? 0)));
    const sims = inBucket
      .map((r) => (r.sim_results as { baseline_60m?: SimGrid } | null)?.baseline_60m)
      .filter((s): s is SimGrid & { pnl_pct: number; outcome: string } =>
        !!s && typeof s.pnl_pct === 'number' && s.outcome !== 'NO_DATA',
      );
    const wins = sims.filter((s) => s.pnl_pct > 0).length;
    const winRate = sims.length ? (wins / sims.length) * 100 : 0;
    const sumPnl = sims.reduce((a, b) => a + b.pnl_pct, 0) * 100;
    const tp = sims.filter((s) => s.outcome === 'TP_HIT').length;
    const sl = sims.filter((s) => s.outcome === 'SL_HIT').length;
    console.log(`  ${label.padEnd(28)} N=${String(inBucket.length).padStart(3)} sim=${String(sims.length).padStart(3)} TP=${String(tp).padStart(2)} SL=${String(sl).padStart(2)} win=${winRate.toFixed(0).padStart(3)}% sumPnl=${sumPnl >= 0 ? '+' : ''}${sumPnl.toFixed(2)}%`);
  }

  // Combien sauvés si seuil 0.4 → 0.3, → 0.2, → 0.0
  console.log(`\nSCÉNARIOS :`);
  for (const newThresh of [0.3, 0.2, 0.1, 0]) {
    const saved = rejected.filter((r) => Number(r.path_eff ?? 0) >= newThresh);
    const sims = saved
      .map((r) => (r.sim_results as { baseline_60m?: SimGrid } | null)?.baseline_60m)
      .filter((s): s is SimGrid & { pnl_pct: number; outcome: string } =>
        !!s && typeof s.pnl_pct === 'number' && s.outcome !== 'NO_DATA',
      );
    const wins = sims.filter((s) => s.pnl_pct > 0).length;
    const winRate = sims.length ? (wins / sims.length) * 100 : 0;
    const sumPnl = sims.reduce((a, b) => a + b.pnl_pct, 0) * 100;
    const tp = sims.filter((s) => s.outcome === 'TP_HIT').length;
    console.log(`  seuil ${newThresh.toFixed(2)} : +${saved.length} sauvés (${(saved.length/2).toFixed(0)}/j) — sim=${sims.length} TP=${tp} winRate=${winRate.toFixed(0)}% sumPnl=${sumPnl >= 0 ? '+' : ''}${sumPnl.toFixed(2)}%`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
