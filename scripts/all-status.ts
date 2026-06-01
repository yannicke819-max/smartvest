import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PIDS: Record<string,string> = {
  'b0000001-0000-0000-0000-000000000001': 'MAIN',
  'a0000001-0000-0000-0000-000000000001': 'HIGH',
  'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
  'a0000003-0000-0000-0000-000000000003': 'SMALL',
  'b0000001-0000-0000-0000-000000000001': 'TRADER_AGENT',
};
(async () => {
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('=== POSITIONS OUVERTES PAR PORTFOLIO ===');
  for (const [pid, name] of Object.entries(PIDS)) {
    const { data, count } = await sb.from('lisa_positions')
      .select('symbol, direction, entry_price, entry_notional_usd, entry_timestamp', { count: 'exact' })
      .eq('portfolio_id', pid).eq('status', 'open');
    console.log(`${name.padEnd(15)} (${pid.slice(0,8)}) — ${count ?? 0} positions`);
    for (const p of (data ?? [])) {
      const ageMin = Math.round((Date.now() - new Date(p.entry_timestamp).getTime()) / 60000);
      console.log(`  ${p.symbol.padEnd(15)} ${p.direction.padEnd(6)} entry=${p.entry_price} $${p.entry_notional_usd} (${ageMin}m)`);
    }
  }
  console.log('\n=== SHADOW SIZING SNAPSHOTS (cron 30min) ===');
  const { data: snaps } = await sb.from('shadow_sizing_snapshot').select('*').order('captured_at', { ascending: false }).limit(5);
  for (const s of (snaps ?? [])) {
    console.log(`  ${s.captured_at?.slice(11,19)} ${s.profile_name?.padEnd(8)} open=${s.open_positions} closed=${s.closed_today} net=$${s.net_pnl_after_fees_usd} drawdown=${s.drawdown_today_pct}%`);
  }
  console.log('\n=== TRADER AGENT DECISIONS ===');
  const { data: ta } = await sb.from('trader_agent_decisions').select('decided_at, action_kind, target_symbol, confidence, action_applied, thesis').order('decided_at', { ascending: false }).limit(5);
  for (const d of (ta ?? [])) {
    console.log(`  ${d.decided_at?.slice(11,19)} ${d.action_kind} ${d.target_symbol ?? '-'} conf=${d.confidence} applied=${d.action_applied} — ${(d.thesis ?? '').slice(0,80)}`);
  }
  console.log('\n=== MARKET CLOSE REPORTS ===');
  const { data: r, count: rc } = await sb.from('market_close_reports').select('*', { count: 'exact' }).order('captured_at', { ascending: false }).limit(3);
  console.log(`Total reports: ${rc ?? 0}`);
  for (const rep of (r ?? [])) {
    console.log(`  ${rep.captured_at?.slice(11,19)} ${rep.session_kind} total_net=$${rep.total_net_pnl_usd} winner=${rep.winner_portfolio_id?.slice(0,8) ?? '-'}`);
  }
})();
