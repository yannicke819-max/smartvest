import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  // Sample 5 rows of status=closed_target
  const { data } = await sb.from('lisa_positions')
    .select('symbol, status, closed_at, entry_timestamp, realized_pnl_usd, exit_reason')
    .eq('portfolio_id', 'b0000001-0000-0000-0000-000000000001')
    .eq('status', 'closed_target')
    .order('entry_timestamp', { ascending: false })
    .limit(5);
  console.log(`Sample 5 closed_target rows:`);
  for (const p of (data ?? [])) {
    console.log(`  entry=${p.entry_timestamp?.slice(0,19)} closed_at=${p.closed_at ?? 'NULL'} ${p.symbol} pnl=$${p.realized_pnl_usd}`);
  }
})();
