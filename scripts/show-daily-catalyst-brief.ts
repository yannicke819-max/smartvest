import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('lisa_decision_log').select('*')
    .eq('kind', 'daily_catalyst_brief')
    .gte('timestamp', '2026-06-01T00:00:00Z')
    .order('timestamp', { ascending: false })
    .limit(1);
  if (!data || data.length === 0) { console.log('vide'); return; }
  const r = data[0];
  console.log('=== Daily Catalyst Brief 04:00 UTC ===');
  console.log(`Generated: ${r.timestamp?.slice(0,19)}`);
  console.log(`Summary: ${r.summary}`);
  console.log(`\nFull payload:`);
  const p = r.payload as any;
  console.log(`Date: ${p?.date}`);
  console.log(`LLM: ${p?.llm_provider} cost=$${p?.llm_cost_usd?.toFixed(4)} latency=${p?.llm_latency_ms}ms`);
  if (p?.macro_events?.length) {
    console.log(`\n📅 MACRO EVENTS (${p.macro_events.length}):`);
    for (const e of p.macro_events) console.log(`  ${e.time_utc} ${e.event.padEnd(50)} [${e.impact}]`);
  }
  if (p?.tickers_to_watch?.length) {
    console.log(`\n👀 TICKERS TO WATCH (${p.tickers_to_watch.length}):`);
    for (const t of p.tickers_to_watch) console.log(`  ${t.ticker.padEnd(14)} [${t.type}] ${t.reason}`);
  }
  if (p?.tickers_to_avoid?.length) {
    console.log(`\n⚠️  TICKERS TO AVOID (${p.tickers_to_avoid.length}):`);
    for (const t of p.tickers_to_avoid) console.log(`  ${t.ticker.padEnd(14)} ${t.reason}`);
  }
  if (p?.sectors_in_focus?.length) console.log(`\n🎯 SECTORS IN FOCUS: ${p.sectors_in_focus.join(', ')}`);
}
main().catch(e => { console.error(e); process.exit(1); });
