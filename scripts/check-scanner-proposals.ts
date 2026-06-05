import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('scanner_proposals').select('*').order('proposed_at', { ascending: false }).limit(2);
  console.log('cols:', Object.keys(data?.[0] ?? {}).sort());
  if (data && data[0]) {
    console.log('\n=== latest scanner_proposal ===');
    for (const k of Object.keys(data[0]).sort()) console.log(`  ${k} = ${JSON.stringify((data[0] as any)[k]).slice(0,150)}`);
  }
}
main().catch(console.error);
