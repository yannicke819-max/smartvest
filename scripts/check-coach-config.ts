import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data } = await sb
    .from('lisa_session_configs')
    .select('portfolio_id, lisa_strategy_coach_enabled, strategy_mode, kill_switch_active, autopilot_enabled, created_at');
  console.log('=== Strategy coach config par portfolio ===');
  for (const r of data ?? []) {
    console.log(`  ${r.portfolio_id?.slice(0,8)} coach=${r.lisa_strategy_coach_enabled}  mode=${r.strategy_mode}  autopilot=${r.autopilot_enabled}  ks=${r.kill_switch_active}  age=${Math.round((Date.now()-new Date(r.created_at).getTime())/86400e3)}d`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
