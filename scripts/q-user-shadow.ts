import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  const SINCE = '2026-05-26T19:09:00Z';
  // user_signals ANY portfolio
  const { data, count } = await sb.from('gainers_user_shadow_signals')
    .select('portfolio_id, symbol, decision, created_at', { count:'exact' })
    .gte('created_at', SINCE)
    .order('created_at', { ascending: false })
    .limit(20);
  console.log(`gainers_user_shadow_signals since 19:09 (ANY pid): ${count ?? 0}`);
  for (const r of (data ?? [])) console.log(`  ${r.created_at?.slice(11,19)} pid=${r.portfolio_id?.slice(0,8)} ${r.symbol} dec=${r.decision}`);
  // Group by decision
  const counts = new Map<string,number>();
  for (const r of (data ?? [])) counts.set(r.decision ?? '?', (counts.get(r.decision ?? '?') ?? 0) + 1);
  console.log('\nBy decision:');
  for (const [k,v] of counts) console.log(`  ${v} × ${k}`);
  
  // Also check the persistence_log fresh
  const { data: gpl } = await sb.from('gainers_persistence_log').select('captured_at, summary').gte('captured_at', SINCE).order('captured_at', { ascending: false }).limit(5);
  console.log(`\npersistence_log since 19:09: ${gpl?.length ?? 0}`);
  for (const r of (gpl ?? [])) console.log(`  ${r.captured_at?.slice(11,19)} ${typeof r.summary === 'string' ? r.summary?.slice(0,100) : JSON.stringify(r.summary)?.slice(0,100)}`);
})();
