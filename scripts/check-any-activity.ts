import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data } = await sb.from('lisa_decision_log')
    .select('kind, portfolio_id, timestamp')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(20);
  console.log(`Last 20 events 30min (all portfolios): ${data?.length ?? 0}`);
  for (const e of (data ?? []).slice(0, 10)) {
    console.log(`  ${e.timestamp.slice(11,19)} ${e.portfolio_id?.slice(0,12)}... ${e.kind}`);
  }
}
main();
