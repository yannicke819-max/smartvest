import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // Oversold events autour de 18:00 UTC (17:55-18:10) sur HIGH
  const { data } = await sb.from('lisa_decision_log')
    .select('timestamp, portfolio_id, kind, summary, payload')
    .in('kind', ['oversold_scan_completed','oversold_scan_blocked_regime'])
    .gte('timestamp','2026-06-05T17:55:00Z')
    .lte('timestamp','2026-06-05T18:15:00Z')
    .order('timestamp', { ascending: true });
  console.log(`Oversold events 17:55-18:15 UTC: ${data?.length ?? 0}`);
  for (const e of data ?? []) {
    console.log(`\n  ${e.timestamp.slice(0,19)} pf=${e.portfolio_id?.slice(0,12)}`);
    console.log(`  kind=${e.kind}`);
    console.log(`  summary=${(e.summary ?? '').slice(0,200)}`);
    const p = e.payload as any;
    if (p) {
      const keys = Object.keys(p).slice(0,15);
      for (const k of keys) console.log(`    ${k}: ${JSON.stringify(p[k]).slice(0,200)}`);
    }
  }
  
  // Toutes les positions OUVERTES via oversold sur HIGH après 17:55
  console.log('\n--- Positions OUVERTES sur HIGH après 17:55 UTC ---');
  const { data: pos } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, status, entry_price, venue_fee_detail')
    .eq('portfolio_id','a0000001-0000-0000-0000-000000000001')
    .gte('entry_timestamp','2026-06-05T17:55:00Z')
    .order('entry_timestamp', { ascending: true });
  console.log(`Total: ${pos?.length ?? 0}`);
  for (const p of pos ?? []) {
    const src = (p.venue_fee_detail as any)?.source ?? 'null';
    console.log(`  ${p.entry_timestamp.slice(11,19)}  ${p.symbol.padEnd(15)}  src=${src}  status=${p.status}`);
  }
}
main().catch(console.error);
