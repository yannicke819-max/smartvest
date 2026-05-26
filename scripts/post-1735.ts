import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const SINCE = '2026-05-26T17:30:00Z';
(async () => {
  console.log(`Now: ${new Date().toISOString()}`);
  for (const t of ['lisa_decision_log', 'gainers_user_shadow_signals', 'gainers_persistence_log', 'lisa_positions', 'gainers_v1_shadow_signals', 'qw_decision_log']) {
    try {
      const col = t === 'gainers_persistence_log' ? 'captured_at' : t === 'lisa_decision_log' ? 'timestamp' : 'created_at';
      const { count } = await sb.from(t).select('*', { count: 'exact', head: true }).gte(col, SINCE);
      console.log(`  ${t.padEnd(35)} since 17:30 = ${count}`);
    } catch (e) { console.log(`  ${t}: ${String(e).slice(0,60)}`); }
  }
})();
