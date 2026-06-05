import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const HIGH = 'a0000001-0000-0000-0000-000000000001';
async function main() {
  const { data, count } = await sb.from('lisa_positions')
    .select('*', { count: 'exact' })
    .eq('portfolio_id', HIGH)
    .order('entry_timestamp', { ascending: false })
    .limit(30);
  console.log(`Total HIGH all-time : ${count}`);
  if (data?.[0]) {
    console.log('\nColumns first row:');
    console.log(Object.keys(data[0]).sort().join(', '));
  }
  const sources = new Map<string, number>();
  for (const p of data ?? []) {
    const src = String((p.venue_fee_detail as Record<string,unknown> | null)?.source ?? '(null)');
    sources.set(src, (sources.get(src) ?? 0) + 1);
  }
  console.log('\nBy venue_fee_detail.source (30 derniers):');
  for (const [src, n] of sources) console.log(`  ${src.padEnd(25)} → ${n}`);

  console.log('\n15 plus récents :');
  for (const p of (data ?? []).slice(0, 15)) {
    const src = (p.venue_fee_detail as Record<string,unknown> | null)?.source ?? '(null)';
    console.log(`  ${String(p.entry_timestamp).slice(0,16)} ${p.status.padEnd(7)} ${String(p.symbol).padEnd(10)} pnl=${p.realized_pnl_usd ?? 'null'} reason=${p.reason ?? '-'} src=${src}`);
  }
}
main().catch(e => console.error(e));
