import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('watchlist_universe').select('*').limit(1);
  console.log('cols:', Object.keys(data?.[0] ?? {}));
  console.log('row sample:', JSON.stringify({...data?.[0], tickers:`[${(data?.[0]?.tickers ?? []).length} tickers]`}));
  const { data: all } = await sb.from('watchlist_universe').select('name, description');
  console.log('\nExisting universes:');
  for (const u of all ?? []) console.log(`  ${u.name} : ${u.description}`);
}
main().catch(console.error);
