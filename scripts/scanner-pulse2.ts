import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = 'b0000001-0000-0000-0000-000000000001';

(async () => {
  // Full payload of latest persistence_log
  const { data: gpl } = await sb.from('gainers_persistence_log')
    .select('*')
    .gte('created_at', '2026-05-26T16:00:00Z')
    .order('created_at', { ascending: false })
    .limit(5);
  console.log('=== gainers_persistence_log latest 5 (full) ===');
  for (const r of (gpl ?? [])) {
    const keys = Object.keys(r);
    const sample: any = {};
    for (const k of keys.slice(0, 20)) sample[k] = (typeof r[k] === 'object' ? JSON.stringify(r[k]).slice(0,80) : String(r[k]).slice(0,60));
    console.log(JSON.stringify(sample));
    console.log('---');
  }

  // gainers_user_shadow_signals post-deploy
  const { data: sigs, count } = await sb.from('gainers_user_shadow_signals')
    .select('*', { count: 'exact' })
    .gte('created_at', '2026-05-26T17:05:34Z')
    .order('created_at', { ascending: false });
  console.log(`\n=== shadow signals post-deploy: ${count ?? 0} ===`);
  for (const r of (sigs ?? []).slice(0, 30)) {
    const decisionKey = Object.keys(r).find(k => k.includes('decision') || k.includes('gate') || k.includes('result') || k.includes('outcome'));
    const decision = decisionKey ? r[decisionKey] : '?';
    const ts = (r.created_at || r.scanned_at).slice(11,19);
    console.log(`  ${ts}  ${(r.symbol ?? r.ticker ?? '-').padEnd(15)} decision=${decision}`);
  }
})();
