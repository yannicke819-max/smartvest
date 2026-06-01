import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  // Check all status values
  const { data } = await sb.from('lisa_positions')
    .select('status')
    .eq('portfolio_id', 'b0000001-0000-0000-0000-000000000001');
  const counts = new Map<string, number>();
  for (const p of (data ?? [])) {
    counts.set(p.status ?? 'null', (counts.get(p.status ?? 'null') ?? 0) + 1);
  }
  console.log(`Status values for MAIN portfolio:`);
  for (const [k, v] of counts) console.log(`  ${v}: ${k}`);
  
  // Latest 10 entries (any status)
  const { data: latest } = await sb.from('lisa_positions')
    .select('symbol, direction, status, closed_at, realized_pnl_usd')
    .eq('portfolio_id', 'b0000001-0000-0000-0000-000000000001')
    .not('closed_at', 'is', null)
    .order('closed_at', { ascending: false })
    .limit(5);
  console.log(`\nLatest 5 closed (any status):`);
  for (const p of (latest ?? [])) {
    console.log(`  ${p.closed_at?.slice(0,19)} ${p.status?.padEnd(15)} ${p.symbol} ${p.direction} pnl=$${p.realized_pnl_usd}`);
  }
})();
