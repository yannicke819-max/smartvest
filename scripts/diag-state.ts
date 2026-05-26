import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

(async () => {
  // List portfolios
  const { data: cfgs } = await sb.from('lisa_session_configs')
    .select('portfolio_id, strategy_mode, autopilot_enabled, autopilot_paused_reason, capital_usd, kill_switch_active, gainers_min_persistence_score')
    .limit(20);
  console.log('=== ALL PORTFOLIOS (lisa_session_configs) ===');
  for (const c of (cfgs ?? [])) {
    console.log(`  ${c.portfolio_id}  mode=${c.strategy_mode} autopilot=${c.autopilot_enabled} paused=${c.autopilot_paused_reason ?? '-'}  cap=$${c.capital_usd}  killswitch=${c.kill_switch_active}  persistence=${c.gainers_min_persistence_score}`);
  }

  // ALL positions today (any portfolio)
  console.log('\n=== ALL POSITIONS ANY-STATUS today (any portfolio) ===');
  const { data: p } = await sb.from('lisa_positions')
    .select('portfolio_id, symbol, direction, status, entry_timestamp, closed_at, realized_pnl_usd, exit_reason')
    .gte('entry_timestamp', '2026-05-26T00:00:00Z')
    .order('entry_timestamp', { ascending: false })
    .limit(50);
  for (const pp of (p ?? [])) {
    console.log(`  ${pp.entry_timestamp?.slice(11,19)} pid=${pp.portfolio_id?.slice(0,8)} ${pp.symbol?.padEnd(15)} ${pp.direction?.padEnd(6)} status=${pp.status?.padEnd(20)} pnl=${pp.realized_pnl_usd ?? '-'} reason=${pp.exit_reason ?? '-'}`);
  }

  // Latest decision_log events any portfolio
  console.log('\n=== LATEST 30 DECISION LOG (any pid, last 1h) ===');
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  const { data: dl } = await sb.from('lisa_decision_log')
    .select('timestamp, portfolio_id, kind, summary')
    .gte('timestamp', oneHourAgo)
    .order('timestamp', { ascending: false })
    .limit(30);
  for (const e of (dl ?? [])) {
    console.log(`  ${e.timestamp?.slice(11,19)} pid=${e.portfolio_id?.slice(0,8)} [${e.kind?.padEnd(35)}] ${(e.summary ?? '').slice(0, 100)}`);
  }
})();
