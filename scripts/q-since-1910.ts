import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  const SINCE = '2026-05-26T19:09:00Z';
  for (const t of [['gainers_persistence_log','captured_at'], ['gainers_v1_shadow_signals','created_at'], ['lisa_decision_log','timestamp'], ['lisa_positions','entry_timestamp']]) {
    const { count } = await sb.from(t[0]).select('*', { count:'exact', head:true }).gte(t[1], SINCE);
    console.log(`  ${t[0].padEnd(32)} since 19:09 = ${count}`);
  }
  // Latest 5 v1 shadow signals
  const { data: sigs } = await sb.from('gainers_v1_shadow_signals').select('created_at, symbol, asset_class, decision, reject_reason').gte('created_at', SINCE).order('created_at', { ascending: false }).limit(5);
  console.log('\nLatest 5 v1 shadow:');
  for (const s of (sigs ?? [])) console.log(`  ${s.created_at?.slice(11,19)} ${s.symbol?.padEnd(15)} ${s.asset_class?.padEnd(15)} dec=${s.decision} reason=${s.reject_reason ?? '-'}`);
  // Latest decision_log any portfolio
  const { data: dl } = await sb.from('lisa_decision_log').select('timestamp, portfolio_id, kind, summary').gte('timestamp', SINCE).order('timestamp', { ascending: false }).limit(10);
  console.log(`\nLatest 10 decision_log:`);
  for (const e of (dl ?? [])) console.log(`  ${e.timestamp?.slice(11,19)} pid=${e.portfolio_id?.slice(0,8)} [${e.kind?.slice(0,30)}] ${(e.summary ?? '').slice(0,80)}`);
})();
