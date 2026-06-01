import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data: probe } = await sb.from('shadow_sizing_decisions').select('*').limit(1);
  if (probe?.[0]) console.log('cols:', Object.keys(probe[0]).join(', '));
  
  // Get latest 10 by all kinds
  const { data } = await sb.from('shadow_sizing_decisions').select('*').order('decided_at', { ascending: false }).limit(10);
  console.log('Latest 10:');
  for (const d of data ?? []) {
    console.log(`  ${d.decided_at?.slice(0,19)} profile=${d.profile_name} kind=${d.decision_kind} trigger=${d.trigger_metric} applied=${d.action_applied}`);
    console.log(`    ${(d.rationale as string)?.slice(0,200)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
