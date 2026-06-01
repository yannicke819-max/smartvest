import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = 'b0000001-0000-0000-0000-000000000001';

async function main() {
  // Open in paper_trades
  const { data: openPaper } = await sb
    .from('paper_trades')
    .select('*')
    .eq('portfolio_id', PID)
    .eq('status', 'open');
  console.log(`paper_trades.status='open' : ${openPaper?.length ?? 0}`);

  // Open in lisa_positions
  const { data: openLisa } = await sb
    .from('lisa_positions')
    .select('id, symbol, status, opened_at, closed_at')
    .eq('portfolio_id', PID)
    .eq('status', 'open');
  console.log(`lisa_positions.status='open' : ${openLisa?.length ?? 0}`);

  // Sample lisa_positions for the 3 Korean symbols
  const koreanSymbols = ['059120.KQ', '016360.KO', '021050.KO'];
  console.log(`\n=== lisa_positions for stale paper_trades Korean symbols ===`);
  for (const sym of koreanSymbols) {
    const { data } = await sb
      .from('lisa_positions')
      .select('id, status, opened_at, closed_at, pnl_pct, entry_price, exit_price')
      .eq('portfolio_id', PID)
      .eq('symbol', sym)
      .gte('opened_at', '2026-05-05')
      .lte('opened_at', '2026-05-08')
      .order('opened_at', { ascending: true });
    console.log(`\n${sym} :`);
    for (const p of data ?? []) {
      const status = p.status === 'open' ? '🟢 OPEN' : `🔴 ${p.status} (pnl=${p.pnl_pct?.toFixed(2) ?? '?'}%)`;
      console.log(`  opened=${p.opened_at?.slice(0,16)}  closed=${p.closed_at?.slice(0,16) ?? '(never)'}  ${status}`);
    }
  }

  // lisa_positions status distribution
  const { data: allLisa } = await sb
    .from('lisa_positions')
    .select('status')
    .eq('portfolio_id', PID);
  const byStatus: Record<string, number> = {};
  for (const r of allLisa ?? []) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log(`\n=== lisa_positions status distribution (this portfolio) ===`);
  for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(25)} ${n}`);
  }
}
main();
