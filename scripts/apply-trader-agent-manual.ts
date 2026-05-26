import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

(async () => {
  // Step 1 : créer le portfolio parent FK
  const { error: pfErr } = await sb.from('portfolios').upsert({
    id: 'b0000001-0000-0000-0000-000000000001',
    user_id: '5f164201-9736-4867-8756-a1653d65fd1c',
    name: 'Trader Agent (Gemini Pro)',
    base_currency: 'USD',
  }, { onConflict: 'id' });
  console.log(`portfolios 'Trader Agent': ${pfErr ? 'ERROR ' + pfErr.message : 'OK'}`);

  // Step 2 : créer la session_config
  const { error: cfgErr } = await sb.from('lisa_session_configs').upsert({
    user_id: '5f164201-9736-4867-8756-a1653d65fd1c',
    portfolio_id: 'b0000001-0000-0000-0000-000000000001',
    profile: 'hyper_active',
    capital_usd: 10000,
    strategy_mode: null,  // NULL → scanner gainers ne scanne PAS ce portfolio
    autopilot_enabled: true,
    kill_switch_active: false,
    gainers_max_open_positions: 10,
    gainers_position_pct: 10.0,
    gainers_max_per_cycle: 2,
    gainers_cash_reserve_pct: 0,
    gainers_min_persistence_score: 0,
    gainers_min_path_efficiency: 0,
    gainers_default_tp_pct: 2.0,
    gainers_default_sl_pct: 1.2,
    gainers_universe_us: true,
    gainers_universe_eu: true,
    gainers_universe_asia: true,
    gainers_universe_crypto: true,
    daily_cost_budget_usd: 50,
    autopilot_cycle_minutes: 5,
    gainers_cycle_minutes: 5,
    base_currency: 'USD',
  }, { onConflict: 'portfolio_id' });
  console.log(`session_config Trader Agent: ${cfgErr ? 'ERROR ' + cfgErr.message : 'OK'}`);

  // Step 3 : vérifier tables existantes
  for (const t of ['trader_agent_decisions', 'trader_agent_memory', 'market_close_reports', 'shadow_sizing_snapshot', 'shadow_sizing_autotune_log']) {
    const { error } = await sb.from(t).select('id', { head: true, count: 'exact' });
    console.log(`Table ${t}: ${error ? 'MISSING (' + error.message + ')' : 'EXISTS'}`);
  }
})();
