import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

(async () => {
  // Exact same query as scanner
  const { data, error, count } = await sb.from('lisa_session_configs')
    .select('user_id, portfolio_id, strategy_mode, autopilot_enabled, kill_switch_active, autopilot_paused_reason', { count: 'exact' })
    .eq('strategy_mode', 'gainers')
    .eq('autopilot_enabled', true)
    .eq('kill_switch_active', false);
  console.log(`Query result: ${count ?? 0} rows`);
  console.log('Error:', error?.message);
  for (const r of (data ?? [])) {
    console.log(JSON.stringify(r));
  }

  // ALL rows of session config (any state)
  console.log('\n=== ALL session configs ===');
  const { data: all } = await sb.from('lisa_session_configs')
    .select('user_id, portfolio_id, strategy_mode, autopilot_enabled, kill_switch_active, autopilot_paused_reason');
  for (const r of (all ?? [])) console.log(JSON.stringify(r));
})();
