import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

const portfolios = [
  { portfolio_id: 'a0000001-0000-0000-0000-000000000001', name: 'high',   max: 3,  pct: 33.33, perCycle: 1 },
  { portfolio_id: 'a0000002-0000-0000-0000-000000000002', name: 'middle', max: 15, pct: 6.67,  perCycle: 4 },
  { portfolio_id: 'a0000003-0000-0000-0000-000000000003', name: 'small',  max: 40, pct: 2.5,   perCycle: 8 },
];

(async () => {
  for (const p of portfolios) {
    const { error } = await sb.from('lisa_session_configs').upsert({
      user_id: '5f164201-9736-4867-8756-a1653d65fd1c',
      portfolio_id: p.portfolio_id,
      profile: 'active_trading',
      capital_usd: 10500,
      strategy_mode: 'gainers',
      autopilot_enabled: true,
      kill_switch_active: false,
      gainers_max_open_positions: p.max,
      gainers_position_pct: p.pct,
      gainers_max_per_cycle: p.perCycle,
      gainers_cash_reserve_pct: 0,
      gainers_min_persistence_score: 0,
      gainers_min_path_efficiency: 0,
      gainers_default_tp_pct: 1.5,
      gainers_default_sl_pct: 1.0,
      gainers_universe_us: true,
      gainers_universe_eu: true,
      gainers_universe_asia: true,
      gainers_universe_crypto: true,
      daily_cost_budget_usd: 50,
      autopilot_cycle_minutes: 5,
      gainers_cycle_minutes: 5,
      base_currency: 'USD',
    }, { onConflict: 'portfolio_id' });
    console.log(`${p.name} (${p.portfolio_id}): ${error ? 'ERROR ' + error.message : 'OK'}`);
  }
})();
