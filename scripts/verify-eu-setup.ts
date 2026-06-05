import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // 1. watchlist_universe.stoxx600
  const { data: uni } = await sb.from('watchlist_universe').select('name, exchange, ticker_suffix, session_open_utc, session_close_utc, tickers').eq('name','stoxx600').maybeSingle();
  if (!uni) {
    console.log('❌ watchlist_universe.stoxx600 → NOT FOUND. Migration 0194 pas appliquée.');
  } else {
    console.log(`✅ watchlist_universe.stoxx600 → ${(uni.tickers as string[])?.length ?? 0} tickers, exchange=${uni.exchange}, session ${uni.session_open_utc}→${uni.session_close_utc}`);
    console.log(`   sample tickers: ${(uni.tickers as string[])?.slice(0,5).join(', ')}`);
  }
  
  // 2. portfolio
  const { data: pf } = await sb.from('portfolios').select('id, name, user_id, base_currency, is_simulation, simulation_initial_capital').eq('id','c0000001-0000-0000-0000-000000000001').maybeSingle();
  if (!pf) {
    console.log('❌ portfolio EU_oversold → NOT FOUND');
  } else {
    console.log(`✅ portfolio EU_oversold → name="${pf.name}" currency=${pf.base_currency} sim=${pf.is_simulation} capital=$${pf.simulation_initial_capital}`);
  }
  
  // 3. lisa_session_config
  const { data: cfg } = await sb.from('lisa_session_configs').select('portfolio_id, strategy_mode, oversold_universe, autopilot_enabled, kill_switch_active, capital_usd, oversold_drop_min_pct, oversold_drop_max_pct, oversold_position_notional_usd, oversold_max_open_positions').eq('portfolio_id','c0000001-0000-0000-0000-000000000001').maybeSingle();
  if (!cfg) {
    console.log('❌ lisa_session_config c0000001 → NOT FOUND');
  } else {
    console.log(`✅ lisa_session_config c0000001 →`);
    console.log(`   strategy=${cfg.strategy_mode} universe=${cfg.oversold_universe} autopilot=${cfg.autopilot_enabled} kill=${cfg.kill_switch_active}`);
    console.log(`   capital=$${cfg.capital_usd}  drop=[${cfg.oversold_drop_min_pct}%, ${cfg.oversold_drop_max_pct}%]`);
    console.log(`   notional=$${cfg.oversold_position_notional_usd}/pos  max_open=${cfg.oversold_max_open_positions}`);
  }
  
  console.log('\n--- État global oversold portfolios ---');
  const { data: all } = await sb.from('lisa_session_configs').select('portfolio_id, oversold_universe, autopilot_enabled, kill_switch_active').eq('strategy_mode','oversold');
  for (const r of all ?? []) {
    console.log(`  ${r.portfolio_id?.slice(0,12)} universe=${r.oversold_universe} autopilot=${r.autopilot_enabled} kill=${r.kill_switch_active}`);
  }
}
main().catch(console.error);
