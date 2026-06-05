import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const EODHD = '69e6325aa2c162.98850425';

async function main() {
  // SPY 5d le 05/06
  const r = await fetch(`https://eodhd.com/api/eod/SPY.US?from=2026-05-25&to=2026-06-05&api_token=${EODHD}&fmt=json`);
  const spy: any[] = await r.json();
  const sorted = spy.sort((a,b)=>a.date.localeCompare(b.date));
  const d05 = sorted.findIndex(d=>d.date==='2026-06-05');
  console.log(`SPY 05/06 close=${sorted[d05].close}  -5d=${sorted[d05-5].date}=${sorted[d05-5].close}  5d=${((sorted[d05].close/sorted[d05-5].close-1)*100).toFixed(2)}%`);
  console.log(`VIX 04/06=15.40 → 05/06=16.72  Δ=${((16.72/15.40-1)*100).toFixed(1)}%`);
  
  // 05/06 oversold HIGH - sans filtre source
  const { data: opens } = await sb.from('lisa_positions')
    .select('symbol, status, realized_pnl_usd, venue_fee_detail, entry_timestamp')
    .gte('entry_timestamp','2026-06-05T00:00:00Z')
    .eq('portfolio_id','a0000001-0000-0000-0000-000000000001');
  console.log(`\nHIGH 05/06 total opened: ${opens?.length ?? 0}`);
  const srcCount: Record<string,number> = {};
  for (const p of opens ?? []) {
    const src = (p.venue_fee_detail as any)?.source ?? 'null';
    srcCount[src] = (srcCount[src] ?? 0) + 1;
  }
  for (const [s,n] of Object.entries(srcCount)) console.log(`  source=${s} : ${n}`);
  
  console.log(`\nDernières 12 positions HIGH ouvertes 05/06:`);
  for (const p of (opens ?? []).slice(0,12)) {
    const src = (p.venue_fee_detail as any)?.source ?? 'null';
    console.log(`  ${p.entry_timestamp.slice(11,19)}  ${p.symbol.padEnd(12)}  src=${src}  status=${p.status}  pnl=$${p.realized_pnl_usd ?? '-'}`);
  }
}
main().catch(console.error);
