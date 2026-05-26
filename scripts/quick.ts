import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const SINCE = '2026-05-26T17:38:00Z';
(async () => {
  for (const t of [['gainers_persistence_log','captured_at'], ['gainers_v1_shadow_signals','created_at'], ['lisa_decision_log','timestamp'], ['lisa_positions','entry_timestamp']]) {
    const { count } = await sb.from(t[0]).select('*', { count:'exact', head:true }).gte(t[1], SINCE);
    console.log(`  ${t[0].padEnd(32)} since 17:38 = ${count}`);
  }
  const { data: latest } = await sb.from('gainers_v1_shadow_signals').select('created_at, symbol, decision, reject_reason').gte('created_at', SINCE).order('created_at', { ascending: false }).limit(5);
  console.log('Latest v1 shadow:');
  for (const r of (latest ?? [])) console.log(`  ${r.created_at?.slice(11,19)} ${r.symbol?.padEnd(15)} dec=${r.decision} reason=${r.reject_reason ?? '-'}`);
})();
