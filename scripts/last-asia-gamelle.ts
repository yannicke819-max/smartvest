import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const PORT: Record<string, string> = {
    'b0000001-0000-0000-0000-000000000001': 'TRADER',
    'a0000001-0000-0000-0000-000000000001': 'HIGH',
    'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
    'a0000003-0000-0000-0000-000000000003': 'SMALL',
  };
  // Latest closes
  const { data } = await sb.from('lisa_positions').select('symbol, portfolio_id, entry_timestamp, exit_timestamp, realized_pnl_usd, exit_reason, status, asset_class')
    .neq('status', 'open')
    .gte('exit_timestamp', '2026-06-01T06:30:00Z')
    .order('exit_timestamp', { ascending: false })
    .limit(20);
  console.log('Trades fermés depuis 06:30 UTC :');
  for (const t of data ?? []) {
    const port = PORT[t.portfolio_id as string] ?? (t.portfolio_id as string)?.slice(0,8);
    console.log(`  ${t.exit_timestamp?.slice(11,16)} ${port.padEnd(8)} ${t.symbol?.padEnd(12)} ${t.asset_class} pnl=$${t.realized_pnl_usd} ${(t.exit_reason as string)?.slice(0,40)}`);
  }
  // Open now
  const { data: open } = await sb.from('lisa_positions').select('symbol, portfolio_id, entry_timestamp, entry_price, entry_notional_usd').eq('status', 'open');
  console.log(`\nOpen positions = ${open?.length}`);
  for (const p of open ?? []) {
    const port = PORT[p.portfolio_id as string] ?? (p.portfolio_id as string)?.slice(0,8);
    console.log(`  ${p.entry_timestamp?.slice(11,16)} ${port.padEnd(8)} ${p.symbol} @ ${p.entry_price} notional=$${p.entry_notional_usd}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
