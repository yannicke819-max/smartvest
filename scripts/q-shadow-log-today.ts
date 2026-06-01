import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('shadow_sizing_autotune_log').select('*')
    .eq('profile_name', 'high')
    .gte('created_at', '2026-06-01T00:00:00Z')
    .order('created_at', { ascending: false }).limit(10);
  console.log(`HIGH autotune logs today: ${data?.length}`);
  for (const r of data ?? []) {
    console.log(`\n${r.created_at?.slice(11,19)} kind=${r.decision_kind} trigger=${r.trigger_metric} applied=${r.action_applied}`);
    console.log(`  rationale: ${(r.rationale as string)?.slice(0, 250)}`);
  }
}
main().catch(e => console.error(e));
