import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Check what /lisa/positions/{portfolioId}?openOnly=false renvoie pour TRADER
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const { data } = await sb.from('lisa_positions').select('symbol, entry_timestamp, exit_timestamp, status, realized_pnl_usd')
    .eq('portfolio_id', TRADER)
    .order('entry_timestamp', { ascending: false })
    .limit(10);
  console.log('Trades TRADER (DB direct):');
  for (const t of data ?? []) {
    console.log(`  ${t.symbol} status=${t.status} entry=${t.entry_timestamp} exit=${t.exit_timestamp} pnl=$${t.realized_pnl_usd}`);
  }

  // Check snapshot history
  const { data: snaps } = await sb.from('lisa_portfolio_snapshots').select('timestamp, total_value_usd')
    .eq('portfolio_id', TRADER)
    .order('timestamp', { ascending: false })
    .limit(5);
  console.log('\nLast 5 snapshots:');
  for (const s of snaps ?? []) console.log(`  ${s.timestamp?.slice(0,19)?.replace('T',' ')} → $${s.total_value_usd}`);
}
main().catch(e => { console.error(e); process.exit(1); });
