import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => { const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc; }, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const r = await sb.from('top_gainers_log').select('*').eq('symbol', 'BTCUSDT').order('captured_at', { ascending: false }).limit(2);
  console.log('top_gainers_log latest BTCUSDT:', JSON.stringify(r.data?.[0] ?? r.error, null, 2).slice(0, 1500));
  const r2 = await sb.from('lisa_decision_log').select('kind, created_at').order('created_at', { ascending: false }).limit(5);
  console.log('\n--- decision_log latest 5 ---');
  for (const x of (r2.data ?? [])) console.log(' ', x.created_at, x.kind);
  // top_gainers_log row count today
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const { count: cnt } = await sb.from('top_gainers_log').select('*', { count: 'exact', head: true }).gte('captured_at', today.toISOString());
  console.log(`\ntop_gainers_log rows today (captured_at >= ${today.toISOString().slice(0,10)}): ${cnt}`);
  const { count: cnt2 } = await sb.from('lisa_decision_log').select('*', { count: 'exact', head: true }).gte('created_at', today.toISOString());
  console.log(`lisa_decision_log rows today : ${cnt2}`);
}
main().catch(e => { console.error(e); process.exit(1); });
