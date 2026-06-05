import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // Tous events HIGH 17:55-18:05
  const { data } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary, payload')
    .eq('portfolio_id','a0000001-0000-0000-0000-000000000001')
    .gte('timestamp','2026-06-05T17:50:00Z')
    .lte('timestamp','2026-06-05T18:10:00Z')
    .order('timestamp', { ascending: true });
  console.log(`HIGH events 17:50-18:10: ${data?.length ?? 0}`);
  for (const e of data ?? []) {
    console.log(`  ${e.timestamp.slice(11,19)}  kind=${e.kind}  ${(e.summary ?? '').slice(0,120)}`);
  }
  
  // Check kill_switch_armed events sur HIGH aujourd'hui
  console.log('\n--- HIGH kill_switch / armed events aujourd\'hui ---');
  const { data: ks } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id','a0000001-0000-0000-0000-000000000001')
    .gte('timestamp','2026-06-05T00:00:00Z')
    .or('kind.like.kill_switch%,kind.eq.killswitch_disarmed,kind.eq.killswitch_armed')
    .order('timestamp', { ascending: true });
  for (const e of ks ?? []) console.log(`  ${e.timestamp.slice(11,19)}  kind=${e.kind}  ${(e.summary ?? '').slice(0,120)}`);
}
main().catch(console.error);
