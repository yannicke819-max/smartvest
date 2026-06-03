/**
 * Investigue le burn EODHD anormal (90k/100k à 05:12 UTC mercredi).
 * Hypothèses :
 *  - Risk monitors crypto qui poll 24/7 (4 classes × intervalle court)
 *  - Pre-warm macro qui re-fire à chaque boot
 *  - Symbol ATR cache refresh
 *  - Scanner cycles trop fréquents (cron every 5min x 4 portfolios)
 *  - Path quality fetch sur chaque candidat scanné
 *
 * Source : on n'a pas de log structuré EODHD calls. On déduit via
 * lisa_decision_log + position_polling logs + scanner cycle counts.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const since = todayUtc.toISOString();

  console.log(`\n=== EODHD BURN AUDIT — depuis ${since} ===\n`);

  // 1. Scanner cycles aujourd'hui
  const { data: scans, count: scanCount } = await sb.from('lisa_decision_log')
    .select('id, created_at, payload', { count: 'exact' })
    .gte('created_at', since)
    .eq('kind', 'scanner_cycle_completed')
    .order('created_at', { ascending: false })
    .limit(500);

  console.log(`1. Scanner cycles aujourd'hui : ${scanCount ?? 0}`);
  if (scans && scans.length > 0) {
    const totalCands = scans.reduce((s: number, r: any) => s + (Number(r.payload?.candidatesScanned ?? 0)), 0);
    console.log(`   Total candidats scannés : ${totalCands}`);
    console.log(`   Moyenne candidats/cycle : ${(totalCands / scans.length).toFixed(0)}`);
  }

  // 2. Shadow signals (chaque enregistrement ~ EODHD calls upstream)
  const { count: shadowCount } = await sb.from('gainers_user_shadow_signals')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since);
  console.log(`\n2. Shadow signals enregistrés : ${shadowCount ?? 0}`);

  // 3. Positions polling (chaque check = 1 EODHD call live price)
  const { count: posCount } = await sb.from('lisa_positions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open');
  console.log(`\n3. Positions ouvertes actuelles : ${posCount ?? 0}`);
  console.log(`   Cron mechanical = 60s → ${(posCount ?? 0)} × 1440 calls/j = ${(posCount ?? 0) * 1440} live_price/j`);

  // 4. risk-monitor cycles (4 classes × every 5min ?)
  const { data: rmLogs, count: rmCount } = await sb.from('lisa_decision_log')
    .select('id, created_at, payload', { count: 'exact' })
    .gte('created_at', since)
    .like('kind', 'risk_monitor%')
    .order('created_at', { ascending: false })
    .limit(500);
  console.log(`\n4. Risk monitor logs aujourd'hui : ${rmCount ?? 0}`);
  if (rmLogs && rmLogs.length > 0) {
    const byKind: Record<string, number> = {};
    for (const r of rmLogs as any[]) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${k.padEnd(40)} ${v}`);
    }
  }

  // 5. Estimation par cycle
  console.log(`\n5. ESTIMATION USAGE PAR HEURE :`);
  console.log(`   Si scanner = 12 cycles/h × ~50 candidats × 2 fetches (snapshot + candles) = ~1200 calls/h`);
  console.log(`   Si 24h continu = ~28800 calls/j (≈ 28% du budget)`);
  console.log(`   À 5:12 = 5h12min écoulées → expected ~6000, observed 90120 = 15× sur-consommation`);

  // 6. Path quality fetches (one per candidate per cycle = explosive)
  console.log(`\n6. CHECK path-quality fetches :`);
  const { count: pqCount } = await sb.from('gainers_persistence_log')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since);
  console.log(`   gainers_persistence_log entries : ${pqCount ?? 0}`);
  console.log(`   Chaque entry = ~6 TF fetches via EODHD intraday`);
  console.log(`   Estimation: ${(pqCount ?? 0) * 6} EODHD intraday calls`);

  // 7. Asia scanner cycles depuis 00:00
  const { count: asiaShadowCount } = await sb.from('gainers_user_shadow_signals')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
    .eq('asset_class', 'asia_equity');
  console.log(`\n7. Asia signals depuis 00:00 UTC : ${asiaShadowCount ?? 0}`);

  // 8. macro pre-warm ?
  const { count: macroCount } = await sb.from('lisa_decision_log')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
    .like('kind', '%macro%');
  console.log(`\n8. Macro decision logs : ${macroCount ?? 0}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
