import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('lisa_session_configs').select('*').eq('portfolio_id','a0000001-0000-0000-0000-000000000001').maybeSingle();
  if (!data) { console.log('no row'); return; }
  console.log('cols:', Object.keys(data));
  console.log('\nHIGH config (a0000001) reference values:');
  for (const k of Object.keys(data).sort()) {
    const v = (data as any)[k];
    const repr = typeof v === 'object' ? JSON.stringify(v) : v;
    console.log(`  ${k} = ${repr}`);
  }
}
main().catch(console.error);
