import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, payload')
    .eq('portfolio_id', TRADER)
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(20);
  for (const e of data ?? []) {
    const p = e.payload as any;
    console.log(`${e.timestamp.slice(11,19)} ${e.kind}`);
    if (p) console.log(`  payload: ${JSON.stringify(p).slice(0, 200)}`);
  }

  // shadow + proposals dernières 5 min
  const since5 = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: shadow } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, asset_class, decision, created_at')
    .gte('created_at', since5)
    .order('created_at', { ascending: false }).limit(20);
  console.log(`\nshadow 5min: ${shadow?.length ?? 0}`);
  for (const s of shadow ?? []) console.log(`  ${s.created_at.slice(11,19)} ${s.symbol.padEnd(14)} ${s.asset_class.padEnd(20)} ${s.decision}`);

  const { data: props } = await sb.from('scanner_proposals')
    .select('symbol, asset_class, score, change_pct, created_at')
    .eq('portfolio_id', TRADER)
    .gte('created_at', since5)
    .order('created_at', { ascending: false }).limit(10);
  console.log(`\nproposals 5min: ${props?.length ?? 0}`);
  for (const p of props ?? []) console.log(`  ${p.created_at.slice(11,19)} ${p.symbol.padEnd(14)} ${p.asset_class.padEnd(20)} score=${Number(p.score).toFixed(2)} change=${Number(p.change_pct).toFixed(1)}%`);
}
main();
