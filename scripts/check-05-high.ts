import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, status, realized_pnl_usd, venue_fee_detail, asset_class')
    .gte('entry_timestamp','2026-06-05T00:00:00Z')
    .eq('portfolio_id','a0000001-0000-0000-0000-000000000001')
    .order('entry_timestamp', { ascending: true });
  console.log(`HIGH 05/06 ouvertes : ${data?.length ?? 0}\n`);
  const srcCount: Record<string,number> = {};
  for (const p of data ?? []) {
    const src = (p.venue_fee_detail as any)?.source ?? 'null';
    srcCount[src] = (srcCount[src] ?? 0) + 1;
  }
  console.log('Sources:');
  for (const [s,n] of Object.entries(srcCount)) console.log(`  ${s} : ${n}`);
  console.log('\nDétail:');
  for (const p of data ?? []) {
    const src = (p.venue_fee_detail as any)?.source ?? 'null';
    console.log(`  ${p.entry_timestamp.slice(11,19)}  ${p.symbol.padEnd(12)}  ${p.asset_class.padEnd(12)}  src=${src.padEnd(28)}  ${p.status.padEnd(20)} pnl=$${p.realized_pnl_usd ?? '-'}`);
  }
}
main().catch(console.error);
