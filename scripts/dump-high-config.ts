import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data, error } = await sb.from('lisa_session_configs').select('*').eq('portfolio_id','a0000001-0000-0000-0000-000000000001');
  if (error) console.log('err:', error.message);
  console.log(`rows: ${data?.length ?? 0}`);
  if (data && data.length > 0) {
    const r = data[0];
    console.log('\n=== HIGH config (reference for EU_oversold) ===');
    const oversoldKeys = Object.keys(r).filter(k => k.startsWith('oversold_'));
    console.log('oversold_* cols:', oversoldKeys);
    for (const k of oversoldKeys.sort()) console.log(`  ${k} = ${JSON.stringify((r as any)[k])}`);
    console.log('\nautres clés pertinentes:');
    for (const k of ['portfolio_id','user_id','strategy_mode','profile','capital_usd','base_currency','autopilot_enabled','kill_switch_active','autopilot_cycle_minutes','risk_constraints','daily_cost_budget_usd']) {
      console.log(`  ${k} = ${JSON.stringify((r as any)[k])}`);
    }
  }
}
main().catch(console.error);
