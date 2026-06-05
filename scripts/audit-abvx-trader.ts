import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // trader_agent_decisions ?
  const tables = ['trader_agent_decisions','live_trader_decisions','scanner_proposals','lisa_proposals'];
  for (const t of tables) {
    try {
      const { data } = await sb.from(t).select('*').limit(2);
      console.log(`${t} cols:`, Object.keys(data?.[0] ?? {}).slice(0,15));
    } catch {}
  }
  console.log();
  // ABVX in any of these
  for (const t of ['trader_agent_decisions','scanner_proposals']) {
    try {
      const cols = await sb.from(t).select('*').limit(1);
      const c = Object.keys(cols.data?.[0] ?? {});
      const symCol = c.includes('symbol') ? 'symbol' : null;
      if (!symCol) continue;
      const { data } = await sb.from(t).select('*').eq('symbol','ABVX.US').gte(c.includes('decided_at') ? 'decided_at' : (c.includes('proposed_at') ? 'proposed_at' : 'created_at'),'2026-06-05T00:00:00Z');
      console.log(`${t} ABVX: ${data?.length ?? 0}`);
      for (const r of data ?? []) console.log(' ', JSON.stringify(r).slice(0,250));
    } catch (e) { console.log(`err ${t}:`, String(e).slice(0,80)); }
  }
  
  // Tout decision_log autour ABVX (élargi 15:40-15:55)
  console.log('\n--- decision_log élargi 15:40-15:55 ABVX ---');
  const { data: all } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id','b0000001-0000-0000-0000-000000000001')
    .gte('timestamp','2026-06-05T15:40:00Z').lte('timestamp','2026-06-05T15:55:00Z');
  for (const l of all ?? []) {
    const txt = (l.summary ?? '');
    if (txt.includes('ABVX')) console.log(`  ${l.timestamp.slice(11,19)} [${l.kind}] ${txt.slice(0,120)}`);
  }
}
main().catch(console.error);
