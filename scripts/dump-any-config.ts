import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('lisa_session_configs').select('*').limit(1);
  console.log('cols:', Object.keys(data?.[0] ?? {}).sort());
  console.log('\nstrategy_modes in DB:');
  const { data: modes } = await sb.from('lisa_session_configs').select('portfolio_id, strategy_mode, oversold_universe, autopilot_enabled');
  for (const m of modes ?? []) console.log(`  pf=${m.portfolio_id?.slice(0,12)} mode=${m.strategy_mode} ou=${m.oversold_universe} ap=${m.autopilot_enabled}`);
}
main().catch(console.error);
