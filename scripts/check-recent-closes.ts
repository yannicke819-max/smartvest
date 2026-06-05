import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 90 * 60_000).toISOString();
  const { data } = await sb.from('lisa_positions')
    .select('*')
    .eq('portfolio_id', TRADER)
    .neq('status', 'open')
    .gte('exit_timestamp', since)
    .order('exit_timestamp', { ascending: false });
  console.log(`Closures TRADER 90min: ${data?.length ?? 0}\n`);
  for (const p of data ?? []) {
    const pnl = Number(p.realized_pnl_usd ?? 0);
    const pnlPct = Number(p.realized_pnl_pct ?? 0);
    const dur = p.exit_timestamp && p.entry_timestamp ? Math.round((new Date(p.exit_timestamp).getTime() - new Date(p.entry_timestamp).getTime()) / 60_000) : null;
    console.log(`═══ ${p.symbol} ═══`);
    console.log(`  entry=$${p.entry_price} → exit=$${p.exit_price}`);
    console.log(`  entry_at=${p.entry_timestamp?.slice(11,19)} → exit_at=${p.exit_timestamp?.slice(11,19)} (${dur}min)`);
    console.log(`  notional=$${p.entry_notional_usd}, qty=${p.quantity}`);
    console.log(`  status=${p.status} reason=${p.exit_reason}`);
    console.log(`  PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
    console.log(`  TP=$${p.take_profit_price}, SL=$${p.stop_loss_price}, peak=$${p.peak_pre_exit}`);
    console.log();
  }
}
main();
