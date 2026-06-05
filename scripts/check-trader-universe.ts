import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER_PORTFOLIO = 'b0000001-0000-0000-0000-000000000001';

  const { data } = await sb
    .from('lisa_session_configs')
    .select('gainers_universe_us, gainers_universe_eu, gainers_universe_asia, gainers_universe_crypto, strategy_mode, autopilot_enabled, kill_switch_active')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .single();

  console.log('TRADER lisa_session_configs current state:');
  console.log(JSON.stringify(data, null, 2));

  // Activity last 30 min (proves Fly is alive and scanner runs)
  const since30 = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: recent } = await sb
    .from('lisa_decision_log')
    .select('kind, timestamp')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .gte('timestamp', since30)
    .order('timestamp', { ascending: false })
    .limit(10);
  console.log(`\nLast 10 decision_log entries TRADER (since ${since30.slice(11,16)}):`);
  for (const r of recent ?? []) {
    console.log(`  ${r.timestamp.slice(11,19)}  ${r.kind}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
