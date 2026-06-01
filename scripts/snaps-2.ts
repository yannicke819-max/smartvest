import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const { data } = await sb.from('lisa_portfolio_snapshots').select('timestamp, total_value_usd')
    .eq('portfolio_id', TRADER)
    .order('timestamp', { ascending: false })
    .limit(5);
  console.log('Latest 5 snapshots TRADER (no date filter, desc):');
  for (const s of data ?? []) console.log(`  ${s.timestamp} → $${s.total_value_usd}`);
}
main().catch(e => { console.error(e); process.exit(1); });
