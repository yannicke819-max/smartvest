import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const since6h = new Date(Date.now() - 6 * 3600_000).toISOString();
  const { data: shadow } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, decision, created_at, entry_price')
    .ilike('symbol', 'ABVX%')
    .gte('created_at', since6h)
    .order('created_at', { ascending: false });
  console.log(`Shadow ABVX 6h: ${shadow?.length ?? 0}`);
  for (const s of shadow ?? []) console.log(`  ${s.created_at.slice(11,19)} ${s.symbol} ${s.decision} entry=$${s.entry_price}`);

  const { data: events } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary, payload')
    .or('summary.ilike.%ABVX%,payload->>symbol.eq.ABVX.PA,payload->>symbol.eq.ABVX.US')
    .gte('timestamp', since6h)
    .order('timestamp', { ascending: false }).limit(20);
  console.log(`\nAny event ABVX 6h: ${events?.length ?? 0}`);
  for (const e of events ?? []) {
    console.log(`  ${e.timestamp.slice(11,19)} ${e.kind} ${(e.summary ?? '').slice(0, 80)}`);
  }
}
main();
