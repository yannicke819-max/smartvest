import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const TRADER = 'b0000001-0000-0000-0000-000000000001';
async function main() {
  const since = new Date(Date.now() - 72*3600_000).toISOString();
  // 1. EU accepts shadow
  const { data: accepts } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, created_at, score, entry_price')
    .eq('asset_class', 'eu_equity').eq('decision', 'accept').gte('created_at', since).limit(500);
  console.log(`EU accepts shadow 72h : ${accepts?.length}`);
  const uniqueAccepts = new Set((accepts ?? []).map(a => a.symbol as string));
  console.log(`  Symboles uniques : ${uniqueAccepts.size}`);
  console.log(`  Sample : ${[...uniqueAccepts].slice(0, 10).join(', ')}`);

  // 2. Actual EU positions opened TRADER 72h
  const { data: opens } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, status, exit_reason, realized_pnl_usd, asset_class')
    .eq('portfolio_id', TRADER)
    .eq('asset_class', 'eu_equity')
    .gte('entry_timestamp', since);
  console.log(`\nEU positions TRADER 72h : ${opens?.length}`);
  for (const p of opens ?? []) {
    console.log(`  ${String(p.entry_timestamp).slice(0,16)} ${String(p.symbol).padEnd(15)} status=${p.status} pnl=${p.realized_pnl_usd} reason=${p.exit_reason}`);
  }

  // 3. What's in decision_log for EU symbols that were rejected POST-accept (downstream gates)
  // skeptic, debate_gate, etc.
  const { data: events } = await sb.from('lisa_decision_log')
    .select('kind, summary, timestamp')
    .eq('portfolio_id', TRADER)
    .in('kind', ['skeptic_verdict', 'scanner_candidate_skip', 'position_open_failed'])
    .gte('timestamp', since)
    .limit(300);
  const euEvents = (events ?? []).filter(e => {
    const s = String(e.summary ?? '');
    return /\.(LSE|PA|XETRA|DE|AS|SW|MI|L)\b/i.test(s);
  });
  console.log(`\nEvents downstream EU (skeptic/scanner_skip/open_failed) 72h : ${euEvents.length}`);
  const byKind = new Map<string, number>();
  for (const e of euEvents) byKind.set(e.kind as string, (byKind.get(e.kind as string) ?? 0) + 1);
  for (const [k, n] of byKind) console.log(`  ${k.padEnd(30)} → ${n}`);
  console.log('\nÉchantillons :');
  for (const e of euEvents.slice(0, 8)) {
    console.log(`  ${String(e.timestamp).slice(0,16)} [${e.kind}] ${String(e.summary).slice(0,80)}`);
  }
}
main().catch(e => console.error(e));
