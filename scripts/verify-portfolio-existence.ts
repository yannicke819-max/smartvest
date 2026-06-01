import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // Check ALL tables that might have 58439d86
  const oldId = '58439d86-3f20-4a60-82a4-307f3f252bc2';
  const newId = 'b0000001-0000-0000-0000-000000000001';

  // 1. portfolios table
  const { data: pFull, error: errP } = await sb.from('portfolios').select('id, name, created_at, status, capital_usd').in('id', [oldId, newId]);
  console.log('=== portfolios table ===');
  console.log('Err:', errP?.message);
  console.log(JSON.stringify(pFull, null, 2));

  // 2. lisa_session_configs
  const { data: cfgs } = await sb.from('lisa_session_configs').select('portfolio_id, strategy_mode, autopilot_enabled, kill_switch_active, capital_usd, created_at').in('portfolio_id', [oldId, newId]);
  console.log('\n=== lisa_session_configs ===');
  console.log(JSON.stringify(cfgs, null, 2));

  // 3. Positions all-time per portfolio
  for (const pid of [oldId, newId]) {
    const { count: total } = await sb.from('lisa_positions').select('*', { count: 'exact', head: true }).eq('portfolio_id', pid);
    const { count: open } = await sb.from('lisa_positions').select('*', { count: 'exact', head: true }).eq('portfolio_id', pid).eq('status', 'open');
    const { count: closed } = await sb.from('lisa_positions').select('*', { count: 'exact', head: true }).eq('portfolio_id', pid).neq('status', 'open');
    console.log(`\n${pid.slice(0,8)} : total=${total}  open=${open}  closed=${closed}`);
  }

  // 4. Decision logs recent for both
  console.log('\n=== Cycles Pro 4h dernières par portfolio ===');
  const { data: cycles } = await sb.from('gemini_ab_decisions').select('portfolio_id', { count: 'exact' }).gte('decided_at', new Date(Date.now() - 4*3600e3).toISOString());
  const counts: Record<string, number> = {};
  for (const c of cycles ?? []) {
    const p = c.portfolio_id as string;
    counts[p] = (counts[p] || 0) + 1;
  }
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.slice(0,8)}: ${v} cycles`);
}
main().catch(e => { console.error(e); process.exit(1); });
