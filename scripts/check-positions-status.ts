import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 90 * 60_000).toISOString();
  const { data } = await sb
    .from('lisa_positions')
    .select('symbol, venue, direction, entry_price, exit_price, entry_notional_usd, status, entry_timestamp, exit_timestamp, exit_reason, realized_pnl_usd, realized_pnl_pct')
    .eq('portfolio_id', TRADER)
    .gte('entry_timestamp', since)
    .order('entry_timestamp', { ascending: false });
  console.log(`\nTRADER positions 90min :\n`);
  for (const p of data ?? []) {
    const pnl = Number(p.realized_pnl_usd ?? 0);
    const pnlPct = Number(p.realized_pnl_pct ?? 0);
    const isClosed = p.exit_timestamp !== null;
    const closeT = isClosed ? `closed=${p.exit_timestamp?.slice(11,19)}` : 'OPEN';
    console.log(`  ${p.symbol.padEnd(12)} ${p.direction.padEnd(5)} entry=$${Number(p.entry_price ?? 0).toFixed(2)} → ${isClosed ? `exit=$${Number(p.exit_price ?? 0).toFixed(2)}` : 'open'} status=${p.status.padEnd(20)} ${closeT} pnl=$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) reason=${p.exit_reason ?? '—'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
