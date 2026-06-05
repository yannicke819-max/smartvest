import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const pf = 'b0000001-0000-0000-0000-000000000001';
  
  // total positions TRADER
  const { count } = await sb.from('lisa_positions').select('id', { count: 'exact', head: true }).eq('portfolio_id', pf);
  console.log(`TRADER total positions: ${count}`);
  
  // closed today
  const todayStart = '2026-06-05T00:00:00Z';
  const { data: todayClosed } = await sb.from('lisa_positions')
    .select('id, symbol, status, entry_timestamp, exit_timestamp, realized_pnl_usd')
    .eq('portfolio_id', pf)
    .neq('status', 'open')
    .gte('exit_timestamp', todayStart)
    .order('exit_timestamp', { ascending: false });
  console.log(`\nClosed today (05/06): ${todayClosed?.length ?? 0}`);
  for (const p of todayClosed ?? []) console.log(`  ${p.exit_timestamp}  ${p.symbol.padEnd(15)} pnl=$${p.realized_pnl_usd}`);
  
  // par défaut limit supabase = 1000. Test si limite atteinte
  const { data: orderedDesc, error: orderErr } = await sb.from('lisa_positions')
    .select('id, symbol, exit_timestamp, status')
    .eq('portfolio_id', pf)
    .order('entry_timestamp', { ascending: false });
  console.log(`\nfetch all (DESC, default limit): ${orderedDesc?.length ?? 0} rows`);
  console.log(`first  entry: ${orderedDesc?.[0]?.symbol} ${orderedDesc?.[0]?.exit_timestamp}`);
  console.log(`last   entry: ${orderedDesc?.[orderedDesc!.length-1]?.symbol} ${orderedDesc?.[orderedDesc!.length-1]?.exit_timestamp}`);
  if (orderErr) console.log('err:', orderErr.message);
}
main();
