import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PORT: Record<string, string> = {
  'b0000001-0000-0000-0000-000000000001': 'TRADER',
  'a0000001-0000-0000-0000-000000000001': 'HIGH',
  'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
  'a0000003-0000-0000-0000-000000000003': 'SMALL',
};

async function main() {
  // 1. Configs comparées des 4 portfolios
  console.log('═══ 1. Config par portfolio (les critères qui peuvent différer) ═══');
  const { data: cfgs } = await sb.from('lisa_session_configs').select('*').in('portfolio_id', Object.keys(PORT));
  const interestingKeys = ['portfolio_id', 'strategy_mode', 'profile', 'capital_usd', 'autopilot_enabled', 'kill_switch_active', 'autopilot_paused_reason', 'gainers_default_sl_pct', 'gainers_default_tp_pct', 'gainers_min_persistence_score', 'gainers_min_path_efficiency', 'gainers_cycle_minutes', 'max_open_positions', 'max_exposure_per_asset_class_pct', 'ticker_cooldown_min', 'max_concurrent_per_class', 'gainers_max_notional_usd', 'gainers_notional_pct'];
  for (const c of cfgs ?? []) {
    console.log(`\n${PORT[c.portfolio_id as string]}:`);
    for (const k of interestingKeys) {
      if (c[k] !== undefined) console.log(`  ${k}: ${c[k]}`);
    }
  }

  // 2. Trades all-time par portfolio incluant les 28/05 wins
  console.log('\n\n═══ 2. Tous trades all-time par portfolio ═══');
  const { data: positions } = await sb
    .from('lisa_positions')
    .select('symbol, asset_class, status, entry_timestamp, exit_timestamp, realized_pnl_usd, exit_reason, portfolio_id, entry_price')
    .in('portfolio_id', Object.keys(PORT))
    .order('entry_timestamp', { ascending: false });
  for (const p of positions ?? []) {
    const port = PORT[p.portfolio_id as string];
    const t = p.entry_timestamp?.slice(0,16)?.replace('T',' ');
    console.log(`  ${port.padEnd(8)} ${t} ${p.symbol?.padEnd(14)} ${p.status?.padEnd(10)} pnl=$${p.realized_pnl_usd ?? '-'} exit=${p.exit_reason ?? '-'}`);
  }

  // 3. Check cooldowns actifs (table dédiée si elle existe)
  console.log('\n\n═══ 3. Decision logs 02:20-02:35 UTC par portfolio (refus skip raisons) ═══');
  const { data: logs } = await sb
    .from('lisa_decision_log')
    .select('created_at, portfolio_id, kind, payload')
    .gte('created_at', '2026-06-01T02:20:00Z')
    .lte('created_at', '2026-06-01T02:35:00Z')
    .in('portfolio_id', Object.keys(PORT))
    .order('created_at', { ascending: true });
  for (const l of logs ?? []) {
    const port = PORT[l.portfolio_id as string] ?? (l.portfolio_id as string)?.slice(0,8);
    const ps = JSON.stringify(l.payload).slice(0, 200);
    console.log(`  ${l.created_at?.slice(11,19)}  ${port.padEnd(8)} ${l.kind?.padEnd(40)} ${ps}`);
  }

  // 4. Tous decision logs autour de 02:26 (ouverture des positions)
  console.log('\n\n═══ 4. Tous decision logs 02:24-02:28 UTC TOUS portfolios ═══');
  const { data: logsAll } = await sb
    .from('lisa_decision_log')
    .select('created_at, portfolio_id, kind, payload')
    .gte('created_at', '2026-06-01T02:24:00Z')
    .lte('created_at', '2026-06-01T02:28:30Z')
    .order('created_at', { ascending: true });
  for (const l of logsAll ?? []) {
    const port = PORT[l.portfolio_id as string] ?? (l.portfolio_id as string)?.slice(0,8);
    const ps = JSON.stringify(l.payload).slice(0, 200);
    console.log(`  ${l.created_at?.slice(11,19)}  ${port.padEnd(8)} ${l.kind?.padEnd(40)} ${ps}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
