/**
 * Backtest funnel + outcomes sur jeudi 22/05 + vendredi 23/05.
 *
 * Source : gainers_user_shadow_signals (décision par gate + sim_results JSONB).
 *
 * Output :
 *   1. Funnel : N candidats par décision (accept / reject_*)
 *   2. Pour chaque bucket, win rate + médiane pnl sur baseline_60m
 *   3. Regret count : combien de REJECT_PATH_EFF / REJECT_PERSISTENCE auraient été
 *      winners s'ils étaient passés (counterfactual)
 *
 * Caveat : 2 jours = sample faible (≤ 200 rows par bucket en général). Trends
 * indicatives uniquement.
 */

import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);

type SimGrid = {
  outcome?: 'TP_HIT' | 'SL_HIT' | 'TIME_LIMIT' | 'NO_DATA';
  pnl_pct?: number;
  exit_at?: string;
  hit_at_min?: number;
};

interface ShadowRow {
  id: string;
  created_at: string;
  symbol: string;
  asset_class: string;
  decision: string;
  change_pct_1m: number | null;
  path_eff: number | null;
  persistence_score: number | null;
  sim_results: { baseline_60m?: SimGrid; alt15_60m?: SimGrid } | null;
}

function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '   n/a';
  // pnl_pct stocké en décimal (0.02 = 2%), on multiplie pour l'affichage
  const pct = n * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

async function main() {
  // Thursday 22/05 00:00 UTC → Saturday 24/05 00:00 UTC (covers Thu+Fri)
  const since = '2026-05-22T00:00:00Z';
  const until = '2026-05-24T00:00:00Z';

  console.log(`\n=== Backtest funnel ${since} → ${until} (Thu+Fri 22-23/05) ===\n`);

  // Pagination — table peut contenir 500+ rows / jour
  const all: ShadowRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from('gainers_user_shadow_signals')
      .select('id, created_at, symbol, asset_class, decision, change_pct_1m, path_eff, persistence_score, sim_results')
      .gte('created_at', since)
      .lt('created_at', until)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) { console.error('Query error:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...(data as ShadowRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`Total rows fetched : ${all.length}\n`);
  if (all.length === 0) {
    console.log('⚠️  Aucune donnée sur cette fenêtre. Vérifie la rétention 30j (active) et que le scanner tournait.');
    return;
  }

  // 1. Funnel par décision
  const byDecision: Record<string, ShadowRow[]> = {};
  for (const r of all) {
    (byDecision[r.decision] ??= []).push(r);
  }

  console.log('=== FUNNEL (Thu+Fri) ===');
  const decisionsOrdered = Object.entries(byDecision).sort((a, b) => b[1].length - a[1].length);
  for (const [dec, rows] of decisionsOrdered) {
    console.log(`  ${dec.padEnd(28)} ${String(rows.length).padStart(5)}  (${(rows.length / all.length * 100).toFixed(1)}%)`);
  }

  // 2. Outcomes par bucket (baseline_60m + alt15_60m)
  console.log('\n=== OUTCOMES par bucket (baseline TP2%/SL0.9%/60min, NET slippage 30bps) ===');
  console.log(`  ${'bucket'.padEnd(28)} ${'N'.padStart(5)} ${'simN'.padStart(6)} ${'TP'.padStart(5)} ${'SL'.padStart(5)} ${'TIME'.padStart(5)} ${'win%'.padStart(7)} ${'medPnl'.padStart(8)} ${'avgPnl'.padStart(8)} ${'best'.padStart(8)} ${'worst'.padStart(8)}`);
  for (const [dec, rows] of decisionsOrdered) {
    const sims = rows
      .map((r) => r.sim_results?.baseline_60m)
      .filter((s): s is SimGrid => !!s && typeof s.pnl_pct === 'number' && s.outcome !== 'NO_DATA');
    if (sims.length === 0) {
      console.log(`  ${dec.padEnd(28)} ${String(rows.length).padStart(5)} ${String(0).padStart(6)}  (pas de sim)`);
      continue;
    }
    const pnls = sims.map((s) => s.pnl_pct as number);
    const tp = sims.filter((s) => s.outcome === 'TP_HIT').length;
    const sl = sims.filter((s) => s.outcome === 'SL_HIT').length;
    const tl = sims.filter((s) => s.outcome === 'TIME_LIMIT').length;
    const wins = pnls.filter((p) => p > 0).length;
    const winPct = (wins / sims.length) * 100;
    const med = median(pnls);
    const avg = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const best = Math.max(...pnls);
    const worst = Math.min(...pnls);
    console.log(`  ${dec.padEnd(28)} ${String(rows.length).padStart(5)} ${String(sims.length).padStart(6)} ${String(tp).padStart(5)} ${String(sl).padStart(5)} ${String(tl).padStart(5)} ${winPct.toFixed(0).padStart(6)}% ${fmtPct(med).padStart(8)} ${fmtPct(avg).padStart(8)} ${fmtPct(best).padStart(8)} ${fmtPct(worst).padStart(8)}`);
  }

  // 3. Regret analysis : REJECTED → counterfactual gain raté
  console.log('\n=== REGRET (REJECTED auraient gagné si pipeline les avait laissés passer) ===');
  const regretBuckets = ['reject_path_eff', 'reject_persistence', 'reject_p_win', 'reject_cooldown', 'reject_post_sl_cooldown'];
  for (const bucket of regretBuckets) {
    const rows = byDecision[bucket] ?? [];
    if (rows.length === 0) continue;
    const sims = rows
      .map((r) => r.sim_results?.baseline_60m)
      .filter((s): s is SimGrid => !!s && typeof s.pnl_pct === 'number' && s.outcome !== 'NO_DATA');
    if (sims.length === 0) continue;
    const wins = sims.filter((s) => (s.pnl_pct ?? 0) > 0);
    const losses = sims.filter((s) => (s.pnl_pct ?? 0) <= 0);
    const winRate = (wins.length / sims.length) * 100;
    const sumWins = wins.reduce((a, b) => a + (b.pnl_pct ?? 0), 0);
    const sumLosses = losses.reduce((a, b) => a + (b.pnl_pct ?? 0), 0);
    const netRegret = sumWins + sumLosses; // total pnl% somme
    const verdict =
      winRate >= 55 && netRegret > 0 ? '⚠️  GATE_TOO_STRICT — laisse passer plus' :
      winRate <= 35 && netRegret < 0 ? '✅ GATE_HEALTHY — bloque bien des losers' :
      '➖ INCONCLUSIVE — sample faible / mixed';
    console.log(`  ${bucket.padEnd(28)} N=${sims.length.toString().padStart(3)} winRate=${winRate.toFixed(0).padStart(3)}% netSumPnl=${fmtPct(netRegret).padStart(8)}  ${verdict}`);
  }

  // 4. ACCEPT par classe (qui sont les pépites ?)
  console.log('\n=== ACCEPT par classe (les pépites supposées) ===');
  const accepted = byDecision['accept'] ?? [];
  const byClass: Record<string, ShadowRow[]> = {};
  for (const r of accepted) (byClass[r.asset_class] ??= []).push(r);
  for (const [cls, rows] of Object.entries(byClass).sort((a, b) => b[1].length - a[1].length)) {
    const sims = rows
      .map((r) => r.sim_results?.baseline_60m)
      .filter((s): s is SimGrid => !!s && typeof s.pnl_pct === 'number' && s.outcome !== 'NO_DATA');
    if (sims.length === 0) {
      console.log(`  ${cls.padEnd(22)} ${rows.length.toString().padStart(3)} accepts (pas de sim)`);
      continue;
    }
    const pnls = sims.map((s) => s.pnl_pct as number);
    const winPct = (pnls.filter((p) => p > 0).length / pnls.length) * 100;
    const med = median(pnls);
    console.log(`  ${cls.padEnd(22)} ${rows.length.toString().padStart(3)} accepts  simN=${sims.length.toString().padStart(3)}  win=${winPct.toFixed(0)}%  medPnl=${fmtPct(med)}`);
  }

  // 5. Top 10 pépites réelles (ACCEPT + TP_HIT + max pnl)
  console.log('\n=== TOP 10 vraies pépites (ACCEPT + TP_HIT, classées par pnl) ===');
  const pepites = accepted
    .map((r) => ({ r, sim: r.sim_results?.baseline_60m }))
    .filter((x): x is { r: ShadowRow; sim: SimGrid } => !!x.sim && x.sim.outcome === 'TP_HIT' && typeof x.sim.pnl_pct === 'number')
    .sort((a, b) => (b.sim.pnl_pct ?? 0) - (a.sim.pnl_pct ?? 0))
    .slice(0, 10);
  if (pepites.length === 0) {
    console.log('  (aucun TP_HIT)');
  } else {
    for (const { r, sim } of pepites) {
      console.log(`  ${r.created_at.slice(11, 16)} ${r.symbol.padEnd(15)} ${r.asset_class.padEnd(20)} pnl=${fmtPct(sim.pnl_pct!)} hit=${(sim.hit_at_min ?? 0).toString().padStart(2)}min  change1m=${fmtPct(Number(r.change_pct_1m ?? 0))}`);
    }
  }

  // 6. Top 10 faux positifs (ACCEPT + SL_HIT, classés par perte)
  console.log('\n=== TOP 10 faux positifs (ACCEPT + SL_HIT, classés par perte) ===');
  const fakeouts = accepted
    .map((r) => ({ r, sim: r.sim_results?.baseline_60m }))
    .filter((x): x is { r: ShadowRow; sim: SimGrid } => !!x.sim && x.sim.outcome === 'SL_HIT' && typeof x.sim.pnl_pct === 'number')
    .sort((a, b) => (a.sim.pnl_pct ?? 0) - (b.sim.pnl_pct ?? 0))
    .slice(0, 10);
  if (fakeouts.length === 0) {
    console.log('  (aucun SL_HIT)');
  } else {
    for (const { r, sim } of fakeouts) {
      console.log(`  ${r.created_at.slice(11, 16)} ${r.symbol.padEnd(15)} ${r.asset_class.padEnd(20)} pnl=${fmtPct(sim.pnl_pct!)} hit=${(sim.hit_at_min ?? 0).toString().padStart(2)}min  pathEff=${(r.path_eff ?? 0).toFixed(2)} persistence=${(r.persistence_score ?? 0).toFixed(2)}`);
    }
  }

  console.log('\n=== Done ===\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
