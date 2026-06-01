import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const HIGH = 'a0000001-0000-0000-0000-000000000001';
  const { data } = await sb.from('lisa_positions').select('symbol, entry_timestamp, exit_timestamp, realized_pnl_usd, status, exit_reason')
    .eq('portfolio_id', HIGH).order('entry_timestamp', { ascending: false }).limit(15);
  console.log('HIGH last 15 trades:');
  let sumPnl = 0;
  for (const t of data ?? []) {
    const pnl = Number(t.realized_pnl_usd ?? 0);
    sumPnl += pnl;
    console.log(`  ${t.entry_timestamp?.slice(0,16)?.replace('T',' ')} → ${t.exit_timestamp?.slice(11,16) ?? 'open'}  ${t.symbol?.padEnd(12)} pnl=$${pnl.toFixed(2)} status=${t.status} reason=${(t.exit_reason as string)?.slice(0,40)}`);
  }
  console.log(`\n  Σ PnL = $${sumPnl.toFixed(2)}`);
  
  // decision log autour de kill switch
  const { data: logs } = await sb.from('lisa_decision_log').select('timestamp, kind, summary')
    .eq('portfolio_id', HIGH)
    .ilike('kind', '%kill%')
    .order('timestamp', { ascending: false })
    .limit(5);
  console.log('\nKill switch logs:');
  for (const l of logs ?? []) console.log(`  ${l.timestamp?.slice(0,19)?.replace('T',' ')} ${l.kind} ${(l.summary as string)?.slice(0,80)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
