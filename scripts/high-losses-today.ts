import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const todayStart = new Date().toISOString().slice(0,10) + 'T00:00:00Z';
  const { data: closes } = await sb.from('lisa_positions')
    .select('symbol, exit_timestamp, realized_pnl_usd, exit_reason, venue_fee_detail')
    .eq('portfolio_id','a0000001-0000-0000-0000-000000000001')
    .gte('exit_timestamp', todayStart)
    .neq('status','open')
    .order('exit_timestamp', { ascending: true });
  console.log(`HIGH closes aujourd'hui : ${closes?.length ?? 0}`);
  let cum = 0;
  for (const c of closes ?? []) {
    const pnl = Number(c.realized_pnl_usd ?? 0);
    cum += pnl;
    const src = (c.venue_fee_detail as any)?.source ?? '?';
    console.log(`  ${c.exit_timestamp.slice(11,19)}  ${c.symbol.padEnd(15)}  pnl=$${pnl.toFixed(2).padStart(8)}  cum=$${cum.toFixed(2).padStart(8)}  src=${src}  reason=${c.exit_reason}`);
  }
  console.log(`\nCumul today HIGH : $${cum.toFixed(2)}`);
  console.log(`Bug trigger : cum < -$525 → drawdownPct > 5% (denom hardcoded 10500)`);
  console.log(`Réel sur capital $150k : -${Math.abs(cum/150000*100).toFixed(2)}% si cum=$${cum.toFixed(0)}`);
  
  console.log('\n--- shadow-sizing kill events aujourd\'hui ---');
  const { data: ks } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary, payload')
    .eq('portfolio_id','a0000001-0000-0000-0000-000000000001')
    .gte('timestamp', todayStart)
    .or('kind.like.kill_switch%,kind.eq.shadow_drawdown_kill,kind.like.shadow_%')
    .order('timestamp', { ascending: true });
  for (const e of ks ?? []) console.log(`  ${e.timestamp.slice(11,19)}  kind=${e.kind}  ${(e.summary ?? '').slice(0,150)}`);
}
main().catch(console.error);
