/**
 * Que s'est-il passé entre 08:00 et 14:30 UTC dans lisa_decision_log ?
 * Et comment BTC s'est-il comporté ?
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // 1. decision_log kind counts in window
  const { data: logs } = await sb
    .from('lisa_decision_log')
    .select('kind, created_at')
    .gte('created_at', '2026-05-24T08:00:00Z')
    .lte('created_at', '2026-05-24T14:30:00Z')
    .limit(2000);
  const counts = new Map<string, number>();
  for (const r of (logs ?? [])) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  console.log(`=== decision_log kind counts 08:00-14:30 UTC (${logs?.length ?? 0} total) ===\n`);
  for (const [k, v] of Array.from(counts.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }

  // 2. BTC price evolution — pull every BTCUSDT row from top_gainers_log
  console.log(`\n=== BTC price/change history 08:00-14:30 UTC (via top_gainers_log) ===`);
  const { data: btc } = await sb
    .from('top_gainers_log')
    .select('symbol, close_price, change_pct, captured_at, sub_persistence_score, decision')
    .gte('captured_at', '2026-05-24T08:00:00+00:00')
    .lte('captured_at', '2026-05-24T14:30:00+00:00')
    .eq('symbol', 'BTCUSDT')
    .order('captured_at', { ascending: true });
  console.log(`  ${btc?.length ?? 0} BTC snapshots\n`);
  let prevPrice: number | null = null;
  for (const r of (btc ?? [])) {
    const at = r.captured_at.slice(11, 19);
    const price = Number(r.close_price);
    const dt = prevPrice ? `(${((price - prevPrice) / prevPrice * 100).toFixed(2)}%)` : '       ';
    prevPrice = price;
    console.log(`  ${at}  $${price.toFixed(2).padStart(10)}  ch1m=${Number(r.change_pct ?? 0).toFixed(2).padStart(6)}% ${dt}  decision=${r.decision ?? '-'}`);
  }

  // 3. Cross-check : à quelle heure BTC a commencé sa baisse durable ?
  if (btc && btc.length > 5) {
    const max = btc.reduce((m, r) => Number(r.close_price) > Number(m.close_price) ? r : m, btc[0]);
    console.log(`\n  📈 Max BTC dans la fenêtre : $${Number(max.close_price).toFixed(2)} @ ${max.captured_at.slice(11,19)}`);
    const last = btc[btc.length - 1];
    console.log(`  📉 Dernier BTC : $${Number(last.close_price).toFixed(2)} @ ${last.captured_at.slice(11,19)}`);
    console.log(`  Variation max → fin : ${((Number(last.close_price) - Number(max.close_price)) / Number(max.close_price) * 100).toFixed(2)}%`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
