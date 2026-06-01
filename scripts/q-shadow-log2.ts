import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data, error } = await sb.from('shadow_sizing_autotune_log').select('*')
    .gte('created_at', '2026-06-01T00:00:00Z')
    .order('created_at', { ascending: false }).limit(20);
  console.log('err:', error?.message, 'count:', data?.length);
  if (data?.[0]) console.log('cols:', Object.keys(data[0]).join(', '));
  for (const r of data ?? []) {
    console.log(`\n${r.created_at?.slice(11,19)} profile=${r.profile_name} kind=${r.decision_kind} trigger=${r.trigger_metric} applied=${r.action_applied}`);
    console.log(`  ${(r.rationale as string)?.slice(0,200)}`);
  }
}
main().catch(e => console.error(e));
