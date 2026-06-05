import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  console.log(`Now: ${new Date().toISOString().slice(11,19)} UTC, since ${since.slice(11,19)}\n`);

  const { data: all } = await sb.from('lisa_decision_log')
    .select('kind, portfolio_id, timestamp')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(30);
  console.log(`All portfolios decision_log last 15min: ${all?.length ?? 0}`);
  for (const e of (all ?? []).slice(0, 15)) {
    console.log(`  ${e.timestamp.slice(11,19)} ${e.portfolio_id?.slice(0,12)}... ${e.kind}`);
  }
}
main();
