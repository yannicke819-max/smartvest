import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('shadow_sizing_autotune_log').select('*').limit(2);
  if (data?.[0]) console.log('cols:', Object.keys(data[0]).join(', '));
  console.log(JSON.stringify(data?.[0], null, 2)?.slice(0, 500));
}
main().catch(e => console.error(e));
