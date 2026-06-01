import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // Try without filters
  const { data, error, count } = await sb.from('shadow_sizing_decisions').select('*', { count: 'exact' }).limit(5);
  console.log('count:', count, 'err:', error?.message);
  console.log(JSON.stringify(data, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
