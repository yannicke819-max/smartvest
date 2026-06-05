import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('lisa_decision_log')
    .select('timestamp, portfolio_id, kind, summary')
    .or('kind.eq.oversold_scan_completed,kind.eq.oversold_scan_blocked_regime,kind.eq.oversold_scan_blocked,kind.like.oversold_%')
    .gte('timestamp','2026-06-05T00:00:00Z')
    .order('timestamp', { ascending: false }).limit(40);
  console.log(`Total oversold events aujourd'hui (05/06): ${data?.length ?? 0}`);
  for (const e of data ?? []) {
    console.log(`  ${e.timestamp.slice(11,19)}  pf=${e.portfolio_id?.slice(0,12)}  kind=${e.kind}  ${(e.summary ?? '').slice(0,80)}`);
  }
}
main().catch(console.error);
