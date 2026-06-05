import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // First, inspect cols of trader_agent_decisions
  const { data: sample } = await sb.from('trader_agent_decisions').select('*').limit(1);
  if (sample?.[0]) {
    console.log('trader_agent_decisions columns:');
    console.log(Object.keys(sample[0]).sort().join(', '));
    console.log('\nSample row:', JSON.stringify(sample[0], null, 2).slice(0, 600));
  } else {
    console.log('trader_agent_decisions is EMPTY (table exists, no rows).');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
