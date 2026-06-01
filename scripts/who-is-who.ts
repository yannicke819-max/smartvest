import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // List all portfolios
  const { data: cfgs } = await sb.from('lisa_session_configs').select('portfolio_id, strategy_mode, profile, capital_usd, autopilot_enabled, kill_switch_active, created_at');
  console.log('=== Tous les portfolios session_configs ===');
  for (const c of cfgs ?? []) {
    console.log(`  ${c.portfolio_id?.slice(0,8)}  mode=${c.strategy_mode}  profile=${c.profile}  cap=$${c.capital_usd}  ap=${c.autopilot_enabled}  ks=${c.kill_switch_active}  created=${c.created_at?.slice(0,10)}`);
  }

  // Now check open positions per actual portfolio
  console.log('\n=== Open positions par portfolio (live) ===');
  const { data: open } = await sb.from('lisa_positions').select('portfolio_id, symbol, asset_class, direction, entry_notional_usd, entry_timestamp').eq('status', 'open');
  const byP: Record<string, any[]> = {};
  for (const p of open ?? []) {
    const pid = (p.portfolio_id as string)?.slice(0,8) ?? 'unk';
    (byP[pid] = byP[pid] || []).push(p);
  }
  for (const [k, v] of Object.entries(byP)) {
    console.log(`  ${k} (${v.length} positions):`);
    for (const p of v) console.log(`    ${p.symbol} ${p.direction} $${p.entry_notional_usd} opened ${p.entry_timestamp?.slice(11,16)} UTC`);
  }

  // Recent cycles all portfolios
  console.log('\n=== Cycles Pro depuis 02:00 UTC (tous portfolios) ===');
  const { data: cycles } = await sb.from('gemini_ab_decisions').select('decided_at, portfolio_id, pro_action_kind, pro_target_symbol, pro_confidence, candidates_count, pro_applied').gte('decided_at', '2026-06-01T02:00:00Z').order('decided_at', { ascending: true });
  for (const r of cycles ?? []) {
    console.log(`  ${r.decided_at?.slice(11,19)}  ${(r.portfolio_id as string)?.slice(0,8)}  ${r.pro_action_kind}/${r.pro_target_symbol ?? '-'}  conf=${r.pro_confidence}  candidates=${r.candidates_count}  applied=${r.pro_applied}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
