import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data } = await sb.from('lisa_decision_log').select('timestamp, payload')
    .eq('kind', 'scanner_candidate_skip').gte('timestamp', since)
    .order('timestamp', { ascending: false }).limit(20);
  console.log('--- VERTICAL_PUMP payloads ---');
  for (const d of data ?? []) {
    const p = d.payload as any;
    if (p?.gate === 'VERTICAL_PUMP') {
      console.log(`${d.timestamp.slice(11,19)} payload: ${JSON.stringify(p)}`);
    }
  }
  console.log('\n--- reject_signal_stale ---');
  const { data: shadow } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, asset_class, decision, entry_price, created_at')
    .eq('decision', 'reject_signal_stale')
    .gte('created_at', since).limit(10);
  for (const s of shadow ?? []) {
    console.log(`  ${s.created_at.slice(11,19)} ${s.symbol.padEnd(14)} ${s.asset_class} entry=$${Number(s.entry_price ?? 0).toFixed(2)}`);
  }
}
main();
