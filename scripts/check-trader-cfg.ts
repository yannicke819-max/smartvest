import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const { data } = await sb.from('lisa_session_configs')
    .select('*')
    .eq('portfolio_id', TRADER)
    .single();
  console.log('TRADER session_config:');
  const keys = ['autopilot_enabled', 'kill_switch_active', 'autopilot_paused_reason', 'strategy_mode', 'gainers_universe_us', 'gainers_universe_eu', 'gainers_universe_asia', 'gainers_universe_crypto', 'gainers_cycle_minutes'];
  for (const k of keys) console.log(`  ${k.padEnd(28)}: ${JSON.stringify((data as any)?.[k])}`);

  // Last decision_log TRADER
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: log } = await sb.from('lisa_decision_log')
    .select('kind, timestamp')
    .eq('portfolio_id', TRADER)
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(10);
  console.log(`\nTRADER decision_log 30min: ${log?.length ?? 0}`);
  for (const e of log ?? []) console.log(`  ${e.timestamp.slice(11,19)} ${e.kind}`);
}
main();
