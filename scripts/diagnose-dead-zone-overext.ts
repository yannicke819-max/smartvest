/**
 * Diagnose les rejets dead_zone + overextended de ce matin Asia.
 * Identifie laquelle des 2 sources (per-class cap vs overpump global)
 * tire les rejets, et quelles classes/symboles sont touchés.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);

  console.log(`\n=== DIAGNOSE dead_zone + overextended — depuis ${since.toISOString()} ===\n`);

  // 1. reject_overextended : breakdown par changePct bucket × class
  const { data: ext } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, asset_class, change_pct_1m')
    .gte('created_at', since.toISOString())
    .eq('decision', 'reject_overextended')
    .limit(5000);

  if (!ext) { console.log('No data'); return; }
  console.log(`Total reject_overextended : ${ext.length}\n`);

  // Bucket distribution
  const buckets = [
    [0, 8],
    [8, 10],
    [10, 12],
    [12, 15],
    [15, 20],
    [20, 30],
    [30, 100],
  ];
  const byBucketClass = new Map<string, number>();

  for (const r of ext) {
    const cp = Number(r.change_pct_1m ?? 0);
    const bk = buckets.find(([lo, hi]) => cp >= lo && cp < hi);
    if (!bk) continue;
    const key = `${bk[0]}-${bk[1]}|${r.asset_class}`;
    byBucketClass.set(key, (byBucketClass.get(key) ?? 0) + 1);
  }

  console.log('reject_overextended par bucket × class :');
  console.log('  bucket    class                 n');
  for (const [k, v] of [...byBucketClass.entries()].sort((a, b) => b[1] - a[1])) {
    const [bk, cls] = k.split('|');
    console.log(`  ${bk.padEnd(8)} ${cls.padEnd(20)} ${v}`);
  }

  // Diagnosis : bucket 12-15 sur asia = OVERPUMP gate, > 30 = per-class cap
  const overpumpZone = ext.filter(r => {
    const cp = Number(r.change_pct_1m ?? 0);
    const cls = String(r.asset_class ?? '');
    if (cls === 'asia_equity') return cp >= 12 && cp < 30; // ce que MAX_CHANGE=30 devrait laisser passer
    if (cls === 'us_equity_large' || cls === 'us_equity_small_mid') return cp >= 12 && cp < 15; // si max US=15
    if (cls === 'eu_equity') return cp >= 12 && cp < 15;
    return false;
  });
  console.log(`\n→ ${overpumpZone.length}/${ext.length} rejets seraient ÉVITÉS si OVERPUMP_THRESHOLD était per-class`);

  // 2. reject_dead_zone : breakdown
  const { data: dz } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, asset_class, change_pct_1m')
    .gte('created_at', since.toISOString())
    .eq('decision', 'reject_dead_zone')
    .limit(5000);

  console.log(`\n\nTotal reject_dead_zone : ${dz?.length ?? 0}`);
  if (dz && dz.length > 0) {
    const dzByClass = new Map<string, number>();
    const dzByBucket = new Map<string, number>();
    for (const r of dz) {
      const cls = String(r.asset_class ?? '');
      const cp = Number(r.change_pct_1m ?? 0);
      const bk = buckets.find(([lo, hi]) => cp >= lo && cp < hi);
      dzByClass.set(cls, (dzByClass.get(cls) ?? 0) + 1);
      if (bk) dzByBucket.set(`${bk[0]}-${bk[1]}`, (dzByBucket.get(`${bk[0]}-${bk[1]}`) ?? 0) + 1);
    }
    console.log('  par class :', [...dzByClass.entries()].map(([k, v]) => `${k}=${v}`).join(' '));
    console.log('  par bucket :', [...dzByBucket.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' '));
  }

  // 3. Symboles uniques touchés par overextended dans la zone overpump
  const uniqueSyms = new Map<string, { count: number; maxChange: number }>();
  for (const r of overpumpZone) {
    const sym = String(r.symbol);
    const cp = Number(r.change_pct_1m ?? 0);
    const cur = uniqueSyms.get(sym) ?? { count: 0, maxChange: 0 };
    cur.count++;
    cur.maxChange = Math.max(cur.maxChange, cp);
    uniqueSyms.set(sym, cur);
  }
  console.log(`\n→ Symboles uniques dans la zone overpump (12-30%) : ${uniqueSyms.size}`);
  console.log('  (ces symboles seraient laissés passer si on bump OVERPUMP_THRESHOLD per-class)');
  console.log('  Top 15 :');
  for (const [sym, v] of [...uniqueSyms.entries()].sort((a, b) => b[1].maxChange - a[1].maxChange).slice(0, 15)) {
    console.log(`    ${sym.padEnd(15)} max=${v.maxChange.toFixed(2)}% (rejeté ${v.count}× ce matin)`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
