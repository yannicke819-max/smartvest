import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

async function main() {
  // Last shadow signals (any) - prove scanner ran
  const { data: lastSig } = await sb
    .from('gainers_user_shadow_signals')
    .select('created_at, decision, symbol')
    .order('created_at', { ascending: false })
    .limit(5);

  console.log('=== Last 5 shadow signals (any decision) ===');
  for (const r of lastSig ?? []) {
    console.log(`  ${r.created_at}  ${r.decision.padEnd(25)}  ${r.symbol}`);
  }

  // Last accept (proves scanner found a candidate)
  const { data: lastAccept } = await sb
    .from('gainers_user_shadow_signals')
    .select('created_at, symbol, change_pct_1m, persistence_score, path_eff')
    .eq('decision', 'accept')
    .order('created_at', { ascending: false })
    .limit(5);

  console.log('\n=== Last 5 ACCEPT decisions ===');
  for (const r of lastAccept ?? []) {
    console.log(`  ${r.created_at}  ${r.symbol.padEnd(15)} cp=${r.change_pct_1m} ps=${r.persistence_score} pe=${r.path_eff}`);
  }

  // Open positions on the active portfolio
  const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';
  const { data: positions } = await sb
    .from('lisa_positions')
    .select('id, symbol, status, opened_at, closed_at, source, entry_price, exit_price, pnl_usd, pnl_pct')
    .eq('portfolio_id', PID)
    .order('opened_at', { ascending: false })
    .limit(10);

  console.log('\n=== Last 10 positions on Simulation SmartVest ===');
  for (const p of positions ?? []) {
    const status = p.status === 'open' ? '🟢 OPEN' : `🔴 CLOSED (${p.pnl_pct?.toFixed(2)}%)`;
    console.log(`  ${p.opened_at}  ${p.symbol.padEnd(15)} ${status}  source=${p.source}`);
  }

  // Open positions count
  const { count: openCount } = await sb
    .from('lisa_positions')
    .select('id', { count: 'exact', head: true })
    .eq('portfolio_id', PID)
    .eq('status', 'open');
  console.log(`\n=== Open positions count : ${openCount ?? 0} ===`);
}
main();
