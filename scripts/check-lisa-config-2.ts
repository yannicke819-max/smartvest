import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('lisa_session_configs').select('*').eq('strategy_mode','oversold').limit(2);
  console.log(`oversold configs found: ${data?.length ?? 0}`);
  for (const r of data ?? []) {
    console.log(`\n=== pf=${r.portfolio_id?.slice(0,12)} ===`);
    const keys = Object.keys(r).filter(k => k.startsWith('oversold_') || ['portfolio_id','user_id','strategy_mode','autopilot_enabled','kill_switch_active','capital_usd','base_currency','profile'].includes(k));
    for (const k of keys.sort()) console.log(`  ${k} = ${JSON.stringify((r as any)[k])}`);
  }
}
main().catch(console.error);
