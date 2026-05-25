import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const since7d  = new Date(Date.now() - 7 * 86400_000).toISOString();
  console.log(`\n=== EODHD Call Consumption (plan 100k/jour) — ${new Date().toISOString().slice(0,16)} UTC ===\n`);

  // eodhd_request_log
  const r1 = await sb.from('eodhd_request_log').select('endpoint', { count: 'exact' }).gte('created_at', since24h).limit(5000);
  if (!r1.error) {
    console.log(`eodhd_request_log 24h : ${r1.count} calls`);
    const map = new Map<string,number>();
    for (const row of (r1.data ?? []) as Array<{endpoint:string}>) {
      const k = row.endpoint ?? '?'; map.set(k, (map.get(k)??0)+1);
    }
    console.log('  Top endpoints:');
    for (const [k,v] of [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8))
      console.log(`    ${String(v).padStart(5)}  ${k}`);
  } else console.log('eodhd_request_log:', r1.error.message);

  const r1w = await sb.from('eodhd_request_log').select('id', { count: 'exact', head: true }).gte('created_at', since7d);
  if (!r1w.error) console.log(`eodhd_request_log 7j  : ${r1w.count} calls`);

  // top_gainers_log
  const r2 = await sb.from('top_gainers_log').select('id', { count: 'exact', head: true }).gte('created_at', since24h);
  console.log(`\ntop_gainers_log 24h   : ${r2.error ? r2.error.message : r2.count + ' scan entries'}`);

  // micro_momentum_probes
  const r3 = await sb.from('micro_momentum_probes').select('id', { count: 'exact', head: true }).gte('created_at', since24h);
  console.log(`micro_momentum_probes : ${r3.error ? r3.error.message : r3.count + ' probes 24h'}`);

  // eodhd_news
  const r4 = await sb.from('eodhd_news').select('id', { count: 'exact', head: true }).gte('persisted_at', since24h);
  console.log(`eodhd_news 24h        : ${r4.error ? r4.error.message : r4.count + ' articles ingérés'}`);

  // Modèle analytique
  console.log(`\n--- Modèle analytique (indépendant des logs) ---`);
  console.log(`Scanner cycle 15min (4/h) × 24h = 96 cycles`);
  console.log(`  Top-gainers fetch     : 1 batch call/cycle × 96         =     96 calls`);
  console.log(`  Persistence (topN=20) : 20 cands × 2 TF sources × 96   =  3 840 calls`);
  console.log(`  News fetch (30min)    : 2/h × 24h                       =     48 calls`);
  console.log(`  Gemini news brief     : 1 batch/jour                    =      1 call`);
  console.log(`  ---`);
  const est = 96 + 3840 + 48 + 1;
  console.log(`  Total estimé/jour     : ~${est} calls`);
  console.log(`  Plan 100 000/jour     : marge libre ~${((1-est/100_000)*100).toFixed(1)}% (${(100_000-est).toLocaleString()} calls restants)`);
}
main().catch(e => { console.error(e); process.exit(1); });
