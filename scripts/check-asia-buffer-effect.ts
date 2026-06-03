/**
 * Vérifie l'effet du nouveau GAINERS_OPEN_BUFFER_MIN sur l'Asia open ce matin.
 * Compare cycle Asia 03h-05h UTC du jour vs même fenêtre J-1 et J-2.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function analyzeWindow(label: string, start: Date, end: Date) {
  const { data, error } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, asset_class, decision, created_at, change_pct_1m')
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString())
    .in('asset_class', ['asia_equity'])
    .order('created_at', { ascending: false })
    .limit(5000);

  if (error) { console.error(error); return; }
  if (!data || data.length === 0) { console.log(`${label}: 0 signals`); return; }

  const byDec: Record<string, number> = {};
  for (const r of data) byDec[r.decision ?? '?'] = (byDec[r.decision ?? '?'] ?? 0) + 1;

  console.log(`\n=== ${label} (${start.toISOString().slice(0,16)} → ${end.toISOString().slice(0,16)}) ===`);
  console.log(`Total asia_equity signals: ${data.length}`);
  console.log('Decisions:');
  for (const [k, v] of Object.entries(byDec).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(35)} ${v}`);
  }

  // Reject_opening_buffer detail
  const obRejects = data.filter(r => r.decision === 'reject_opening_buffer');
  if (obRejects.length > 0) {
    const bySuffix: Record<string, number> = {};
    for (const r of obRejects) {
      const m = String(r.symbol ?? '').match(/\.([A-Z]+)$/);
      const s = m ? m[1] : 'NONE';
      bySuffix[s] = (bySuffix[s] ?? 0) + 1;
    }
    console.log('  reject_opening_buffer par suffix:', Object.entries(bySuffix).map(([k,v])=>`.${k}=${v}`).join(' '));
  }

  // Acceptances
  const accepts = data.filter(r => r.decision === 'accept');
  if (accepts.length > 0) {
    console.log(`  ✓ ACCEPTS (${accepts.length}):`);
    for (const a of accepts.slice(0, 10)) {
      console.log(`    ${a.symbol} ${(Number(a.change_pct_1m ?? 0)).toFixed(2)}% @ ${a.created_at.slice(11,16)}`);
    }
  }
}

async function main() {
  const now = new Date();
  // Today 03h-05h UTC
  const today03 = new Date(now);
  today03.setUTCHours(3, 0, 0, 0);
  const today05 = new Date(now);
  today05.setUTCHours(5, 30, 0, 0);

  // J-1 same window
  const j1_03 = new Date(today03); j1_03.setUTCDate(j1_03.getUTCDate() - 1);
  const j1_05 = new Date(today05); j1_05.setUTCDate(j1_05.getUTCDate() - 1);

  // J-2 same window
  const j2_03 = new Date(today03); j2_03.setUTCDate(j2_03.getUTCDate() - 2);
  const j2_05 = new Date(today05); j2_05.setUTCDate(j2_05.getUTCDate() - 2);

  await analyzeWindow('AUJOURD\'HUI', today03, today05);
  await analyzeWindow('J-1', j1_03, j1_05);
  await analyzeWindow('J-2', j2_03, j2_05);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
