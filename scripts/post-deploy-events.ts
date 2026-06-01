import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = 'b0000001-0000-0000-0000-000000000001';
const DEPLOY_TS = '2026-05-26T17:05:34Z';

(async () => {
  console.log(`Now: ${new Date().toISOString()} — deploy was ${DEPLOY_TS}`);
  const { data } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id', PID)
    .gte('timestamp', DEPLOY_TS)
    .order('timestamp', { ascending: false })
    .limit(80);
  console.log(`${data?.length ?? 0} events post-deploy:`);
  const counts = new Map<string, number>();
  for (const e of (data ?? [])) {
    const tag = e.kind?.includes('STALE_GUARD') || e.summary?.includes('STALE_GUARD') ? '🚫STALE' :
                e.kind?.includes('position_opened') ? '✅OPEN' :
                e.kind?.includes('position_closed') ? '❌CLOSE' :
                e.kind?.includes('skip') || e.summary?.includes('skip') ? '⏭️' : '  ';
    console.log(`  ${tag} ${e.timestamp?.slice(11,19)} [${e.kind?.padEnd(35)}] ${(e.summary ?? '').slice(0, 110)}`);
    counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  }
  console.log('\n--- Kind counts post-deploy ---');
  for (const [k,v] of Array.from(counts.entries()).sort((a,b)=>b[1]-a[1])) console.log(`  ${v.toString().padStart(3)} ${k}`);

  // Count specific STALE patterns
  const stales = (data ?? []).filter(e => (e.summary ?? '').includes('stale_twelvedata') || (e.summary ?? '').includes('stale_eodhd'));
  console.log(`\nSTALE events post-deploy: ${stales.length}`);
  const sources = new Map<string, number>();
  for (const s of stales) {
    const m = (s.summary ?? '').match(/source=(\S+)/);
    const src = m ? m[1] : 'unknown';
    sources.set(src, (sources.get(src) ?? 0) + 1);
  }
  for (const [k,v] of sources) console.log(`  ${v} × ${k}`);
})();
