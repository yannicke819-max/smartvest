import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const HIGH = 'a0000001-0000-0000-0000-000000000001';
  const { data } = await sb.from('lisa_session_configs').select('portfolio_id, kill_switch_active, autopilot_enabled, autopilot_paused_reason, strategy_mode').eq('portfolio_id', HIGH).single();
  console.log('HIGH config:', JSON.stringify(data, null, 2));
  // All 4 for comparison
  const { data: all } = await sb.from('lisa_session_configs').select('portfolio_id, kill_switch_active, autopilot_enabled, autopilot_paused_reason').in('portfolio_id', ['b0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000001', 'a0000002-0000-0000-0000-000000000002', 'a0000003-0000-0000-0000-000000000003']);
  console.log('\nAll 4 portfolios:');
  const names: Record<string,string> = {'b0000001-0000-0000-0000-000000000001':'TRADER','a0000001-0000-0000-0000-000000000001':'HIGH','a0000002-0000-0000-0000-000000000002':'MIDDLE','a0000003-0000-0000-0000-000000000003':'SMALL'};
  for (const c of all ?? []) {
    console.log(`  ${names[c.portfolio_id as string]?.padEnd(8)} ks=${c.kill_switch_active} ap=${c.autopilot_enabled} reason=${c.autopilot_paused_reason ?? 'no'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
