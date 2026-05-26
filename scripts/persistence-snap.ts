import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

(async () => {
  const { data } = await sb.from('gainers_persistence_log')
    .select('captured_at, snapshot_json, summary')
    .gte('captured_at', '2026-05-26T17:00:00Z')
    .order('captured_at', { ascending: false })
    .limit(2);
  for (const r of (data ?? [])) {
    console.log(`\n=== captured_at=${r.captured_at} ===`);
    const snap = typeof r.snapshot_json === 'string' ? JSON.parse(r.snapshot_json) : r.snapshot_json;
    const sum = typeof r.summary === 'string' ? JSON.parse(r.summary) : r.summary;
    console.log('Summary:', JSON.stringify(sum));
    const cands = snap?.candidates ?? [];
    console.log(`${cands.length} candidates:`);
    for (const c of cands.slice(0, 15)) {
      console.log(`  ${c.symbol?.padEnd(15)} class=${c.assetClass?.padEnd(10)} 1m=${c.tf1m?.toFixed?.(2) ?? '-'} 5m=${c.tf5m?.toFixed?.(2) ?? '-'} 10m=${c.tf10m?.toFixed?.(2) ?? '-'} score=${c.persistenceScore?.toFixed?.(2) ?? '-'}`);
    }
  }
})();
