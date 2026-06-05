import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const { data } = await sb
    .from('lisa_session_configs')
    .select('gainers_cycle_minutes, autopilot_cycle_minutes, profile, capital_discipline_mode, strategy_mode, capital_usd, max_open_positions, max_exposure_per_asset_class_pct, max_exposure_per_instrument_pct, daily_cost_budget_usd, autopilot_paused_reason')
    .eq('portfolio_id', TRADER)
    .single();
  console.log('TRADER session config:');
  console.log(JSON.stringify(data, null, 2));

  // Check ALL portfolios in mode gainers to see who else gets scanned
  const { data: allGainers } = await sb
    .from('lisa_session_configs')
    .select('portfolio_id, strategy_mode, autopilot_enabled, gainers_universe_us, gainers_universe_eu, gainers_cycle_minutes')
    .eq('strategy_mode', 'gainers');
  console.log(`\nALL gainers portfolios (${allGainers?.length ?? 0}) :`);
  for (const p of allGainers ?? []) {
    const isTrader = p.portfolio_id === TRADER ? '🎯' : '  ';
    console.log(`  ${isTrader} ${p.portfolio_id.slice(0,12)}... autopilot=${p.autopilot_enabled} cycle=${p.gainers_cycle_minutes}min us=${p.gainers_universe_us} eu=${p.gainers_universe_eu}`);
  }

  // Last 10 events across ALL portfolios (any kind)
  const since30 = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: anyEvents } = await sb
    .from('lisa_decision_log')
    .select('portfolio_id, kind, timestamp')
    .gte('timestamp', since30)
    .order('timestamp', { ascending: false })
    .limit(20);
  console.log(`\nLast 20 decision_log ALL portfolios 30min:`);
  for (const e of anyEvents ?? []) {
    const isTrader = e.portfolio_id === TRADER ? '🎯' : '  ';
    console.log(`  ${isTrader} ${e.timestamp.slice(11,19)} ${e.portfolio_id.slice(0,12)}... ${e.kind}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
