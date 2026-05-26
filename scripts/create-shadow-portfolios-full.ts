import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

const portfolios = [
  { id: 'a0000001-0000-0000-0000-000000000001', name: 'Shadow High Sizing',   max: 3,  pct: 33.33, perCycle: 1 },
  { id: 'a0000002-0000-0000-0000-000000000002', name: 'Shadow Middle Sizing', max: 15, pct: 6.67,  perCycle: 4 },
  { id: 'a0000003-0000-0000-0000-000000000003', name: 'Shadow Small Sizing',  max: 20, pct: 5,     perCycle: 8 },
];

(async () => {
  // Step 1 — create portfolios rows first (parent FK)
  for (const p of portfolios) {
    const { error } = await sb.from('portfolios').upsert({
      id: p.id,
      user_id: '5f164201-9736-4867-8756-a1653d65fd1c',
      name: p.name,
      base_currency: 'USD',
    }, { onConflict: 'id' });
    console.log(`portfolios row '${p.name}': ${error ? 'ERROR ' + error.message : 'OK'}`);
  }

  // Step 2 — create session_configs
  for (const p of portfolios) {
    const { error } = await sb.from('lisa_session_configs').upsert({
      user_id: '5f164201-9736-4867-8756-a1653d65fd1c',
      portfolio_id: p.id,
      profile: 'hyper_active',
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
    console.log(`session_config '${p.name}': ${error ? 'ERROR ' + error.message : 'OK'}`);
  }

  // Verify
  const ids = portfolios.map(p => p.id);
  const { data } = await sb.from('lisa_session_configs').select('portfolio_id, gainers_max_open_positions, gainers_position_pct, strategy_mode, autopilot_enabled, gainers_min_persistence_score, gainers_min_path_efficiency').in('portfolio_id', ids);
  console.log(`\n=== Verification ===`);
  console.log(`In DB: ${data?.length}/3`);
  for (const r of (data ?? [])) console.log(`  ${r.portfolio_id} max=${r.gainers_max_open_positions} pct=${r.gainers_position_pct}% mode=${r.strategy_mode} autopilot=${r.autopilot_enabled} persist=${r.gainers_min_persistence_score} pathEff=${r.gainers_min_path_efficiency}`);
})();
