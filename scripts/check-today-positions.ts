import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const today = new Date(Date.now() - 6 * 3600_000).toISOString();
  const { data } = await sb.from('lisa_positions')
    .select('symbol, status, entry_price, exit_price, entry_timestamp, exit_timestamp, realized_pnl_usd, exit_reason')
    .eq('portfolio_id', TRADER)
    .gte('entry_timestamp', today)
    .order('entry_timestamp', { ascending: true });
  console.log(`Positions TRADER 6h (toutes):`);
  for (const p of data ?? []) {
    const dur = p.exit_timestamp ? Math.round((new Date(p.exit_timestamp).getTime() - new Date(p.entry_timestamp).getTime()) / 60_000) : null;
    const pnl = Number(p.realized_pnl_usd ?? 0);
    console.log(`  ${p.entry_timestamp.slice(11,19)} ${p.symbol.padEnd(12)} ${p.status.padEnd(22)} entry=$${p.entry_price} exit=${p.exit_price ? `$${p.exit_price}` : '—'} pnl=$${pnl.toFixed(2)} dur=${dur ?? 'OPEN'}min reason=${(p.exit_reason ?? '').slice(0, 40)}`);
  }
}
main();
