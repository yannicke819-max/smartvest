import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('portfolios')
    .select('id, name, user_id, base_currency, created_at')
    .in('id', ['b0000001-0000-0000-0000-000000000001','a0000001-0000-0000-0000-000000000001'])
    .order('created_at', { ascending: true });
  console.log('Portfolios existants:');
  for (const p of data ?? []) console.log(`  ${p.id.slice(0,12)}... name=${p.name} user_id=${p.user_id} currency=${p.base_currency}`);
  
  // schema portfolios
  const { data: one } = await sb.from('portfolios').select('*').limit(1);
  console.log('\nportfolios cols:', Object.keys(one?.[0] ?? {}));
}
main().catch(console.error);
