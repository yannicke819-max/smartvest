import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('watchlist_universe').select('name, exchange, session_open_utc, session_close_utc, ticker_suffix, description').eq('name','russell1000');
  console.log(JSON.stringify(data, null, 2));
}
main().catch(console.error);
