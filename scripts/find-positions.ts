import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  for (const tbl of ['paper_trades', 'lisa_positions', 'paper_broker_positions', 'gainers_paper_positions']) {
    const { data, error, count } = await sb.from(tbl).select('*', { count: 'exact' }).limit(3);
    if (error) { console.log(`  ${tbl} : ERROR ${error.message}`); continue; }
    console.log(`  ${tbl} : ${count ?? 0} rows. Sample cols : ${data && data[0] ? Object.keys(data[0]).slice(0, 10).join(', ') : '(empty)'}`);
  }

  // Look for ANY row mentioning XRPUSDT today
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  for (const tbl of ['paper_trades', 'lisa_positions']) {
    const r = await sb.from(tbl).select('*').eq('symbol', 'XRPUSDT').gte('created_at', todayStart.toISOString()).limit(5);
    if (r.error) {
      // Try alternate timestamp column
      const r2 = await sb.from(tbl).select('*').eq('symbol', 'XRPUSDT').limit(5);
      console.log(`\n  ${tbl} XRPUSDT (last 5 any time): ${r2.data?.length ?? 0} rows`);
      for (const row of (r2.data ?? [])) {
        console.log(`    `, JSON.stringify(row).slice(0, 250));
      }
    } else {
      console.log(`\n  ${tbl} XRPUSDT today: ${r.data?.length ?? 0} rows`);
      for (const row of (r.data ?? [])) console.log(`    `, JSON.stringify(row).slice(0, 250));
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
