import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  const SINCE = '2026-05-26T19:12:00Z';
  const { data } = await sb.from('lisa_decision_log')
    .select('timestamp, portfolio_id, kind, summary')
    .gte('timestamp', SINCE)
    .order('timestamp', { ascending: false })
    .limit(30);
  console.log(`decision_log since 19:12 ANY portfolio: ${data?.length ?? 0}`);
  for (const e of (data ?? [])) {
    console.log(`  ${e.timestamp?.slice(11,19)} pid=${e.portfolio_id?.slice(0,8)} [${e.kind?.padEnd(35)}] ${(e.summary ?? '').slice(0, 100)}`);
  }
  // group by kind
  const counts = new Map<string,number>();
  for (const e of (data ?? [])) counts.set(e.kind ?? '?', (counts.get(e.kind ?? '?') ?? 0) + 1);
  console.log('\nBy kind:');
  for (const [k,v] of Array.from(counts.entries()).sort((a,b)=>b[1]-a[1])) console.log(`  ${v} × ${k}`);
})();
