import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const MIDDLE = 'a0000002-0000-0000-0000-000000000002';
const TRADER = 'b0000001-0000-0000-0000-000000000001';
const HIGH = 'a0000001-0000-0000-0000-000000000001';
const SMALL = 'a0000003-0000-0000-0000-000000000003';

async function main() {
  // 1. ALL trades MIDDLE depuis 1 semaine
  console.log('═══ MIDDLE all trades (7 derniers jours) ═══');
  const since7d = new Date(Date.now() - 7 * 24 * 3600e3).toISOString();
  const { data: middleTrades } = await sb
    .from('lisa_positions')
    .select('symbol, asset_class, direction, entry_price, exit_price, entry_notional_usd, realized_pnl_usd, exit_reason, entry_timestamp, exit_timestamp, peak_pre_exit, stop_loss_price, take_profit_price, status')
    .eq('portfolio_id', MIDDLE)
    .gte('entry_timestamp', since7d)
    .order('entry_timestamp', { ascending: true });

  if (!middleTrades || middleTrades.length === 0) {
    console.log('AUCUN trade MIDDLE sur 7j !');
  } else {
    for (const t of middleTrades) {
      const opened = t.entry_timestamp?.slice(0, 16)?.replace('T', ' ');
      const closed = t.exit_timestamp?.slice(11, 16) ?? 'open';
      const realPct = t.entry_price && t.exit_price ? ((Number(t.exit_price) - Number(t.entry_price)) / Number(t.entry_price)) * 100 : null;
      const mfePct = t.entry_price && t.peak_pre_exit ? ((Number(t.peak_pre_exit) - Number(t.entry_price)) / Number(t.entry_price)) * 100 : null;
      console.log(`  ${opened} → ${closed}  ${t.symbol?.padEnd(14)} ${t.asset_class?.padEnd(15)} entry=$${t.entry_price} notional=$${t.entry_notional_usd}  exit=$${t.exit_price ?? '-'} (${realPct?.toFixed(2) ?? '-'}%)  mfe=${mfePct?.toFixed(2) ?? '-'}%  pnl=$${t.realized_pnl_usd ?? '-'}  reason=${t.exit_reason?.slice(0, 25)}`);
    }
  }

  // 2. Compare with TRADER + HIGH + SMALL on same days
  console.log('\n═══ TOUS portfolios 28/05 - 01/06 ═══');
  for (const [name, pid] of [['TRADER', TRADER], ['HIGH', HIGH], ['MIDDLE', MIDDLE], ['SMALL', SMALL]]) {
    const { data } = await sb
      .from('lisa_positions')
      .select('symbol, realized_pnl_usd, entry_timestamp, status')
      .eq('portfolio_id', pid)
      .gte('entry_timestamp', since7d)
      .order('entry_timestamp', { ascending: true });
    const total = (data ?? []).length;
    const wins = (data ?? []).filter(t => Number(t.realized_pnl_usd ?? 0) > 0).length;
    const sumPnl = (data ?? []).reduce((s, t) => s + Number(t.realized_pnl_usd ?? 0), 0);
    console.log(`  ${name.padEnd(7)} : ${total} trades, ${wins} wins, Σ pnl=$${sumPnl.toFixed(2)}`);
  }

  // 3. MIDDLE config historique vs now
  console.log('\n═══ MIDDLE config actuelle ═══');
  const { data: cfg } = await sb
    .from('lisa_session_configs')
    .select('*')
    .eq('portfolio_id', MIDDLE)
    .single();
  if (cfg) {
    const keys = ['gainers_position_pct', 'gainers_max_open_positions', 'gainers_max_per_cycle', 'gainers_min_change_pct_eu', 'gainers_min_change_pct_us_smallmid', 'gainers_min_path_efficiency', 'gainers_min_persistence_score', 'gainers_cycle_minutes', 'autopilot_enabled', 'kill_switch_active', 'gainers_default_sl_pct', 'gainers_default_tp_pct'];
    for (const k of keys) console.log(`  ${k.padEnd(40)} : ${cfg[k]}`);
  }

  // 4. Scanner signals MIDDLE depuis 7j
  console.log('\n═══ MIDDLE scanner signals (gainers_user_shadow_signals) 7j ═══');
  const { count: totalSignals } = await sb
    .from('gainers_user_shadow_signals')
    .select('*', { count: 'exact', head: true })
    .eq('portfolio_id', MIDDLE)
    .gte('created_at', since7d);
  const { data: byDecision } = await sb
    .from('gainers_user_shadow_signals')
    .select('decision')
    .eq('portfolio_id', MIDDLE)
    .gte('created_at', since7d);
  const decisions: Record<string, number> = {};
  for (const r of byDecision ?? []) decisions[r.decision as string] = (decisions[r.decision as string] || 0) + 1;
  console.log(`  Total signals : ${totalSignals}`);
  console.log(`  Decisions :`);
  for (const [k, v] of Object.entries(decisions).sort((a, b) => b[1] - a[1])) console.log(`    ${v.toString().padStart(5)} ${k}`);
}
main().catch(e => { console.error(e); process.exit(1); });
