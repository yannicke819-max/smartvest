import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = 'b0000001-0000-0000-0000-000000000001';
(async () => {
  const sinceDeploy = '2026-05-26T17:05:34Z';
  const { data, count } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary', { count: 'exact' })
    .eq('portfolio_id', PID)
    .gte('timestamp', sinceDeploy)
    .order('timestamp', { ascending: false });
  console.log(`Now=${new Date().toISOString()}  events post-deploy=${count ?? 0}`);
  for (const e of (data ?? []).slice(0, 15)) {
    console.log(`  ${e.timestamp?.slice(11,19)} [${e.kind?.padEnd(35)}] ${(e.summary ?? '').slice(0,100)}`);
  }
})();
