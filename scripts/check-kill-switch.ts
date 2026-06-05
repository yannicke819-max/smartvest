import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // État kill_switch sur HIGH + TRADER
  const { data } = await sb.from('lisa_session_configs')
    .select('portfolio_id, kill_switch_active, autopilot_enabled, capital_usd, strategy_mode')
    .in('portfolio_id', ['a0000001-0000-0000-0000-000000000001','b0000001-0000-0000-0000-000000000001','c0000001-0000-0000-0000-000000000001']);
  console.log('Config états :');
  for (const r of data ?? []) console.log(`  ${r.portfolio_id.slice(0,12)}  mode=${r.strategy_mode}  kill=${r.kill_switch_active}  autopilot=${r.autopilot_enabled}  capital=$${r.capital_usd}`);
  
  // Dernier snapshot HIGH + drawdown
  console.log('\n--- Derniers snapshots HIGH (a0000001) ---');
  const { data: sn } = await sb.from('lisa_portfolio_snapshots')
    .select('timestamp, total_value_usd, drawdown_from_peak_pct, return_from_inception_pct, realized_pnl_cumulative_usd, unrealized_pnl_usd, open_positions_count')
    .eq('portfolio_id','a0000001-0000-0000-0000-000000000001')
    .order('timestamp', { ascending: false }).limit(5);
  for (const s of sn ?? []) console.log(`  ${s.timestamp.slice(0,19)}  total=$${Number(s.total_value_usd).toFixed(0)}  DD=${s.drawdown_from_peak_pct}%  return=${s.return_from_inception_pct}%  open=${s.open_positions_count}  realized=$${s.realized_pnl_cumulative_usd}`);
  
  // Dernier snapshot TRADER
  console.log('\n--- Derniers snapshots TRADER (b0000001) ---');
  const { data: snT } = await sb.from('lisa_portfolio_snapshots')
    .select('timestamp, total_value_usd, drawdown_from_peak_pct, return_from_inception_pct, realized_pnl_cumulative_usd, open_positions_count')
    .eq('portfolio_id','b0000001-0000-0000-0000-000000000001')
    .order('timestamp', { ascending: false }).limit(5);
  for (const s of snT ?? []) console.log(`  ${s.timestamp.slice(0,19)}  total=$${Number(s.total_value_usd).toFixed(0)}  DD=${s.drawdown_from_peak_pct}%  return=${s.return_from_inception_pct}%  open=${s.open_positions_count}  realized=$${s.realized_pnl_cumulative_usd}`);
  
  // décisions kill_switch_anti_spiral récentes
  console.log('\n--- decision_log kill_switch armed ---');
  const { data: kl } = await sb.from('lisa_decision_log')
    .select('timestamp, portfolio_id, kind, summary, payload')
    .or('kind.eq.kill_switch_armed,kind.eq.kill_switch_anti_spiral,kind.eq.trader_kill_switch_armed')
    .gte('timestamp','2026-06-05T00:00:00Z')
    .order('timestamp', { ascending: false }).limit(10);
  for (const k of kl ?? []) console.log(`  ${k.timestamp}  pf=${k.portfolio_id?.slice(0,12)} kind=${k.kind} sum=${(k.summary ?? '').slice(0,100)}`);
}
main().catch(console.error);
