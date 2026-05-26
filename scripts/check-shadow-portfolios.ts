import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  const ids = ['a0000001-0000-0000-0000-000000000001','a0000002-0000-0000-0000-000000000002','a0000003-0000-0000-0000-000000000003'];
  const { data } = await sb.from('lisa_session_configs').select('portfolio_id, capital_usd, gainers_max_open_positions, gainers_position_pct, gainers_min_persistence_score, gainers_min_path_efficiency, strategy_mode, autopilot_enabled').in('portfolio_id', ids);
  console.log(`Shadow portfolios in DB: ${data?.length ?? 0}/3`);
  for (const r of (data ?? [])) {
    console.log(`  ${r.portfolio_id} : max=${r.gainers_max_open_positions} pct=${r.gainers_position_pct}% cap=$${r.capital_usd} persist=${r.gainers_min_persistence_score} pathEff=${r.gainers_min_path_efficiency} mode=${r.strategy_mode} autopilot=${r.autopilot_enabled}`);
  }
  // Tables
  for (const t of ['shadow_sizing_snapshot', 'shadow_sizing_autotune_log']) {
    const { error } = await sb.from(t).select('*', { count: 'exact', head: true });
    console.log(`Table ${t}: ${error ? 'NOT EXISTS' : 'EXISTS'}`);
  }
})();
