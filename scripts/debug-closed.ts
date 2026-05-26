import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  // Direct sample of latest closed
  const { data, count } = await sb.from('lisa_positions')
    .select('portfolio_id, symbol, direction, status, entry_timestamp, closed_at, realized_pnl_usd, exit_reason', { count: 'exact' })
    .eq('portfolio_id', '58439d86-3f20-4a60-82a4-307f3f252bc2')
    .neq('status', 'open')
    .order('closed_at', { ascending: false })
    .limit(10);
  console.log(`Latest 10 closed positions MAIN (total: ${count}):`);
  for (const p of (data ?? [])) {
    console.log(`  closed=${p.closed_at} status=${p.status} ${p.symbol} ${p.direction} pnl=$${p.realized_pnl_usd}`);
  }
})();
