import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  const { data } = await sb.from('market_close_reports').select('captured_at, session_kind, window_start, window_end, total_net_pnl_usd, total_closed_count, winner_portfolio_id, portfolio_breakdown').order('captured_at', { ascending: false }).limit(3);
  for (const r of (data ?? [])) {
    console.log(`\n=== ${r.captured_at} ${r.session_kind} ===`);
    console.log(`window: ${r.window_start} → ${r.window_end}`);
    console.log(`total_net=$${r.total_net_pnl_usd} closed=${r.total_closed_count} winner=${r.winner_portfolio_id?.slice(0,8) ?? '-'}`);
    if (Array.isArray(r.portfolio_breakdown)) {
      for (const pb of r.portfolio_breakdown) {
        console.log(`  ${pb.name.padEnd(14)} closed=${pb.closed_count} wins=${pb.wins}/${pb.losses} gross=$${pb.gross_pnl_usd} fees=$${pb.fees_usd} net=$${pb.net_pnl_usd}`);
      }
    }
  }
})();
