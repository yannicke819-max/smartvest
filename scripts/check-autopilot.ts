import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = 'b0000001-0000-0000-0000-000000000001';

(async () => {
  // Recent events ALL (any kind)
  const { data: recent } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id', PID)
    .order('timestamp', { ascending: false })
    .limit(40);
  console.log(`=== LATEST 40 events ANY kind ===`);
  for (const e of (recent ?? [])) {
    console.log(`  ${e.timestamp?.slice(11,19)} [${e.kind?.padEnd(40)}] ${(e.summary ?? '').slice(0,90)}`);
  }

  // Session config detail
  const { data: cfg } = await sb.from('lisa_session_configs')
    .select('*')
    .eq('portfolio_id', PID)
    .single();
  console.log(`\n=== SESSION CONFIG ===`);
  console.log(`  strategy_mode: ${cfg?.strategy_mode}`);
  console.log(`  autopilot_enabled: ${cfg?.autopilot_enabled}`);
  console.log(`  autopilot_paused_reason: ${cfg?.autopilot_paused_reason}`);
  console.log(`  kill_switch_active: ${cfg?.kill_switch_active}`);
  console.log(`  daily_cost_budget_usd: ${cfg?.daily_cost_budget_usd}`);
  console.log(`  gainers_cycle_minutes: ${cfg?.gainers_cycle_minutes}`);
  console.log(`  capital_usd: ${cfg?.capital_usd}`);
  console.log(`  gainers_min_persistence_score: ${cfg?.gainers_min_persistence_score}`);
})();
