import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = 'b0000001-0000-0000-0000-000000000001';

(async () => {
  // Try multiple tables to see scanner activity
  const tables = [
    'gainers_persistence_log',
    'gainers_user_shadow_signals',
    'lisa_proposals',
    'lisa_mechanical_cycle_summary',
    'lisa_mechanical_directives',
  ];
  for (const t of tables) {
    try {
      const { data, error } = await sb.from(t)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(3);
      if (error) { console.log(`${t}: ERROR ${error.message}`); continue; }
      console.log(`\n=== ${t} (${data?.length} rows) ===`);
      for (const r of (data ?? [])) {
        const ts = (r.created_at || r.timestamp || r.scanned_at || r.recorded_at || '?').toString().slice(0,19);
        const sym = r.symbol || r.ticker || '-';
        const kind = r.kind || r.event_kind || r.event_type || '-';
        const status = r.status || r.gate_result || r.outcome || '-';
        console.log(`  ${ts}  ${sym?.padEnd(15)} kind=${kind}  status=${status}`);
      }
    } catch (e) { console.log(`${t}: ${String(e).slice(0,80)}`); }
  }
})();
