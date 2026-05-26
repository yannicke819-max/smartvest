import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  const sinceDeploy = '2026-05-26T17:05:34Z';
  const { data: dl } = await sb.from('lisa_decision_log')
    .select('timestamp, portfolio_id, kind, summary')
    .gte('timestamp', sinceDeploy)
    .order('timestamp', { ascending: false })
    .limit(80);
  console.log(`Total decision_log post-deploy (all portfolios): ${dl?.length ?? 0}`);
  for (const e of (dl ?? []).slice(0, 40)) {
    console.log(`  ${e.timestamp?.slice(11,19)} pid=${e.portfolio_id?.slice(0,8)} [${e.kind?.padEnd(35)}] ${(e.summary ?? '').slice(0, 90)}`);
  }
  // Persistence log all
  const { data: gpl } = await sb.from('gainers_persistence_log')
    .select('captured_at, top_n, summary')
    .gte('captured_at', sinceDeploy)
    .order('captured_at', { ascending: false });
  console.log(`\nPersistence log post-deploy: ${gpl?.length ?? 0} ticks`);
  for (const r of (gpl ?? [])) console.log(`  ${r.captured_at?.slice(11,19)} ${r.summary?.slice?.(0,80)}`);
})();
