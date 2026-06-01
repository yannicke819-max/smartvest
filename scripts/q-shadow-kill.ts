import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('shadow_sizing_decisions').select('*')
    .eq('decision_kind', 'sizing_suggestion')
    .gte('decided_at', '2026-06-01T00:00:00Z')
    .order('decided_at', { ascending: false })
    .limit(10);
  console.log(`Last 10 shadow_sizing decisions today:`);
  for (const d of data ?? []) {
    console.log(`\n${d.decided_at?.slice(11,19)} profile=${d.profile_name} kind=${d.trigger_metric} applied=${d.action_applied}`);
    console.log(`  rationale: ${(d.rationale as string)?.slice(0, 250)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
