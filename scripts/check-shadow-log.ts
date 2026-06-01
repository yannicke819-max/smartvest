import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { count, error } = await sb.from('shadow_sizing_autotune_log').select('*', { count: 'exact', head: true });
  console.log('shadow_sizing_autotune_log:', count, error?.message);
  if (count !== null) {
    const { data } = await sb.from('shadow_sizing_autotune_log').select('*').order('created_at', { ascending: false }).limit(3);
    if (data?.[0]) console.log('cols:', Object.keys(data[0]).join(', '));
    for (const r of data ?? []) console.log(`  ${r.created_at?.slice(0,19)} ${r.profile_name} ${r.decision_kind} applied=${r.action_applied} ${(r.rationale as string)?.slice(0,100)}`);
  }
}
main().catch(e => console.error(e));
