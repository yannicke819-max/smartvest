import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = 'b0000001-0000-0000-0000-000000000001';

async function main() {
  // Try paper_trades
  const { data: pt, error: ptErr } = await sb
    .from('paper_trades')
    .select('id, symbol, status, opened_at, closed_at, source, pnl_pct')
    .eq('portfolio_id', PID)
    .order('opened_at', { ascending: false })
    .limit(15);
  if (ptErr) console.log('paper_trades err:', ptErr.message);
  else {
    console.log(`=== paper_trades on Sim SmartVest : ${pt?.length ?? 0} ===`);
    for (const p of pt ?? []) console.log(`  ${p.opened_at}  ${p.symbol.padEnd(15)} ${p.status}  source=${p.source}  pnl=${p.pnl_pct}`);
  }

  // Last decision_log for this portfolio around 12-13h UTC
  const { data: log } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id', PID)
    .gte('timestamp', '2026-05-25T12:00:00Z')
    .order('timestamp', { ascending: false })
    .limit(30);
  console.log(`\n=== decision_log last 30 since 12:00 UTC ===`);
  for (const l of log ?? []) console.log(`  ${l.timestamp}  ${l.kind.padEnd(30)}  ${l.summary?.slice(0, 80)}`);

  // Open positions on ALL portfolios via paper_trades
  const { data: openAll } = await sb
    .from('paper_trades')
    .select('id, portfolio_id, symbol, opened_at')
    .eq('status', 'open');
  console.log(`\n=== ALL open paper_trades (across portfolios) : ${openAll?.length ?? 0} ===`);
  for (const o of openAll ?? []) console.log(`  ${o.opened_at}  pid=${o.portfolio_id.slice(0,8)} ${o.symbol}`);
}
main();
