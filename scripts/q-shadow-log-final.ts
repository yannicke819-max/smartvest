import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('shadow_sizing_autotune_log').select('decided_at, profile_name, decision_kind, trigger_metric, action_applied, rationale')
    .eq('profile_name', 'high')
    .gte('decided_at', '2026-06-01T06:00:00Z')
    .order('decided_at', { ascending: false }).limit(15);
  console.log(`HIGH today logs since 06:00 UTC: ${data?.length}`);
  for (const r of data ?? []) {
    console.log(`\n${r.decided_at?.slice(11,19)} ${r.decision_kind} trigger=${r.trigger_metric} applied=${r.action_applied}`);
    console.log(`  ${(r.rationale as string)?.slice(0, 250)}`);
  }
}
main().catch(e => console.error(e));
