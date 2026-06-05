import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }
function fmt(n: number | null, d = 2): string { return n == null ? 'n/a' : Number(n).toFixed(d); }

async function main() {
  const since = new Date(Date.now() - 72 * 3600_000).toISOString();
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' ANALYSE REJECTED — Quels gates bloquent les BONS candidats US/EU ?');
  console.log(`   Fenêtre : 72h depuis ${since.slice(0, 16)}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // 1. Load all shadow signals 72h on US/EU (asset_class != asia)
  const { data, count } = await sb
    .from('gainers_user_shadow_signals')
    .select('symbol, asset_class, decision, score, change_pct_1m, persistence_score, path_eff, entry_price, sim_results, sim_window_max_min, created_at', { count: 'exact' })
    .gte('created_at', since)
    .neq('asset_class', 'asia_equity')
    .order('created_at', { ascending: false })
    .limit(5000);

  if (!data?.length) { console.log('Aucune donnée'); return; }
  console.log(`Loaded ${data.length} shadow signals US/EU 72h (total all classes: ${count})`);

  // 2. Classify by decision + asset_class
  const byClass = new Map<string, Map<string, number>>();
  for (const s of data) {
    const cls = String(s.asset_class);
    const dec = String(s.decision);
    if (!byClass.has(cls)) byClass.set(cls, new Map());
    byClass.get(cls)!.set(dec, (byClass.get(cls)!.get(dec) ?? 0) + 1);
  }
  console.log('\nPar asset_class × decision :');
  for (const [cls, m] of byClass) {
    const total = [...m.values()].reduce((s, n) => s + n, 0);
    console.log(`  ${pad(cls, 25)} total=${total}`);
    for (const [d, n] of [...m].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${pad(d, 30)} → ${n} (${((n/total)*100).toFixed(0)}%)`);
    }
  }

  // 3. For each REJECT, look at sim_results to know if it WOULD have been profitable
  // sim_results = { max_pnl_pct, hit_tp, hit_sl, ... } simulated on actual price
  type Reject = { symbol: string; cls: string; dec: string; score: number | null; maxPnl: number | null; hitTp: boolean | null; tpPct: number | null; pathEff: number | null; persist: number | null };
  const rejects: Reject[] = [];
  for (const s of data) {
    const dec = String(s.decision).toLowerCase();
    if (dec === 'accept') continue;  // ignore accepts, only look at rejects
    const sim = s.sim_results as Record<string, unknown> | null;
    rejects.push({
      symbol: String(s.symbol),
      cls: String(s.asset_class),
      dec: String(s.decision),
      score: s.score as number | null,
      maxPnl: sim ? (sim.max_pnl_pct as number ?? null) : null,
      hitTp: sim ? (sim.hit_tp as boolean ?? null) : null,
      tpPct: sim ? (sim.tp_pct as number ?? null) : null,
      pathEff: s.path_eff as number | null,
      persist: s.persistence_score as number | null,
    });
  }

  // 4. Bucket: GOOD-MISS (max_pnl > tp_pct = aurait fait TP), MARGINAL, BAD
  const byDecisionGoodness = new Map<string, { good: number; marginal: number; bad: number; nodata: number; sumGoodPnl: number }>();
  for (const r of rejects) {
    const acc = byDecisionGoodness.get(r.dec) ?? { good: 0, marginal: 0, bad: 0, nodata: 0, sumGoodPnl: 0 };
    if (r.maxPnl == null) acc.nodata++;
    else if (r.maxPnl >= 1.5) { acc.good++; acc.sumGoodPnl += r.maxPnl; }
    else if (r.maxPnl >= 0.3) acc.marginal++;
    else acc.bad++;
    byDecisionGoodness.set(r.dec, acc);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' VERDICT : pour chaque type de reject, quels % auraient été bons ?');
  console.log('   GOOD = sim max_pnl ≥ 1.5%  |  MARGINAL = 0.3-1.5%  |  BAD = < 0.3%');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  console.log(`${pad('REJECT TYPE', 35)} ${pad('TOTAL', 6)} ${pad('GOOD', 10)} ${pad('MARGINAL', 10)} ${pad('BAD', 10)} ${pad('NO_DATA', 10)} ${pad('AVG GOOD MFE', 12)}`);
  const sorted = [...byDecisionGoodness].sort((a, b) => (b[1].good + b[1].marginal + b[1].bad + b[1].nodata) - (a[1].good + a[1].marginal + a[1].bad + a[1].nodata));
  for (const [d, s] of sorted) {
    const total = s.good + s.marginal + s.bad + s.nodata;
    const goodPct = total > 0 ? ((s.good / total) * 100).toFixed(0) + '%' : '–';
    const avgGoodMfe = s.good > 0 ? (s.sumGoodPnl / s.good).toFixed(2) + '%' : 'n/a';
    console.log(`${pad(d, 35)} ${pad(total, 6)} ${pad(`${s.good} (${goodPct})`, 10)} ${pad(s.marginal, 10)} ${pad(s.bad, 10)} ${pad(s.nodata, 10)} ${pad(avgGoodMfe, 12)}`);
  }

  // 5. TOP 10 missed gold — rejected candidates with highest max_pnl
  const sorted2 = [...rejects].filter(r => r.maxPnl != null && r.maxPnl >= 2.0).sort((a, b) => (b.maxPnl ?? 0) - (a.maxPnl ?? 0));
  console.log(`\nTOP 10 candidats RATÉS (max_pnl > 2%, classés par max_pnl) :`);
  console.log(`  ${pad('SYMBOL', 12)} ${pad('CLASS', 22)} ${pad('REJECT', 30)} ${pad('MAX_PNL', 8)} HITS_TP`);
  for (const r of sorted2.slice(0, 10)) {
    console.log(`  ${pad(r.symbol, 12)} ${pad(r.cls, 22)} ${pad(r.dec, 30)} ${pad(fmt(r.maxPnl), 8)}% ${r.hitTp ? '✅' : '❌'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
