import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('position_indicators_snapshot').select('*').limit(1);
  console.log('All columns:');
  if (data?.[0]) console.log(Object.keys(data[0]).sort().join(', '));
}
main();
