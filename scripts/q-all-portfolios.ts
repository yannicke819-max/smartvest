import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const PORT: Record<string,string> = {'b0000001-0000-0000-0000-000000000001':'TRADER','a0000001-0000-0000-0000-000000000001':'HIGH','a0000002-0000-0000-0000-000000000002':'MIDDLE','a0000003-0000-0000-0000-000000000003':'SMALL'};

async function main() {
  for (const [pid, name] of Object.entries(PORT)) {
    const { data: cfg } = await sb.from('lisa_session_configs').select('kill_switch_active, autopilot_enabled, autopilot_paused_reason').eq('portfolio_id', pid).single();
    const { data: closed } = await sb.from('lisa_positions').select('realized_pnl_usd').eq('portfolio_id', pid).neq('status', 'open').gte('exit_timestamp', '2026-06-01T00:00:00Z');
    const { data: openPos } = await sb.from('lisa_positions').select('symbol, entry_notional_usd, entry_timestamp').eq('portfolio_id', pid).eq('status', 'open');
    const sumPnl = (closed ?? []).reduce((s, t) => s + Number(t.realized_pnl_usd ?? 0), 0);
    const exposure = (openPos ?? []).reduce((s, t) => s + Number(t.entry_notional_usd ?? 0), 0);
    console.log(`\n${name.padEnd(8)} ks=${cfg?.kill_switch_active} ap=${cfg?.autopilot_enabled} reason=${cfg?.autopilot_paused_reason ?? 'no'}`);
    console.log(`  Today: ${closed?.length ?? 0} closed, Σ pnl=$${sumPnl.toFixed(2)}`);
    console.log(`  Open: ${openPos?.length ?? 0} positions, exposure=$${exposure.toFixed(0)}`);
    for (const p of openPos ?? []) {
      console.log(`    ${p.entry_timestamp?.slice(11,16)} ${p.symbol} $${p.entry_notional_usd}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
