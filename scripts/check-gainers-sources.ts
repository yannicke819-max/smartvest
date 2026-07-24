import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // Which portfolios are in gainers mode?
  const { data: cfgs } = await sb.from('lisa_session_configs')
    .select('portfolio_id, strategy_mode, autopilot_enabled, kill_switch_active');
  console.log('Tous portfolios :');
  for (const c of cfgs ?? []) {
    console.log(`  ${(c.portfolio_id as string).slice(0,8)} mode=${c.strategy_mode} ap=${c.autopilot_enabled} ks=${c.kill_switch_active}`);
  }
  // For each gainers portfolio, count positions by source
  const gainersIds = (cfgs ?? []).filter(c => c.strategy_mode === 'gainers').map(c => c.portfolio_id as string);
  console.log(`\n${gainersIds.length} portfolios en mode gainers`);
  for (const pid of gainersIds) {
    const { data: pos } = await sb.from('lisa_positions')
      .select('venue_fee_detail, status, entry_timestamp')
      .eq('portfolio_id', pid)
      .gte('entry_timestamp', '2026-06-01T00:00:00Z')
      .order('entry_timestamp', { ascending: false })
      .limit(200);
    const srcs = new Map<string,number>();
    for (const p of pos ?? []) {
      const s = String((p.venue_fee_detail as Record<string,unknown>|null)?.source ?? '(null)');
      srcs.set(s, (srcs.get(s) ?? 0) + 1);
    }
    console.log(`\n${pid.slice(0,8)} positions depuis 01/06 : ${pos?.length}`);
    for (const [s, n] of [...srcs].sort((a,b)=>b[1]-a[1])) console.log(`  ${s.padEnd(35)} → ${n}`);
  }
}
main().catch(e => console.error(e));
