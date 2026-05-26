import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const SINCE = '2026-05-26T17:30:00Z';
(async () => {
  const { data, error } = await sb.from('gainers_v1_shadow_signals')
    .select('*')
    .gte('created_at', SINCE)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) { console.log('ERROR', error.message); return; }
  console.log(`${data?.length ?? 0} latest shadow signals since 17:30`);
  console.log('Sample row keys:', Object.keys(data?.[0] ?? {}).join(', '));
  console.log('---');
  for (const r of (data ?? [])) {
    const ts = r.created_at?.slice(11,19);
    const sym = r.symbol || r.ticker || '-';
    console.log(JSON.stringify({
      ts, sym,
      decision: r.decision || r.gate_result || r.outcome || r.status,
      reason: r.reason || r.skip_reason || r.rejection_reason,
      score: r.persistence_score || r.score,
      pathEff: r.path_efficiency || r.path_eff,
      bloc1: r.bloc1_score || r.bloc1_decision,
    }, null, 0));
  }
  // Group by decision
  const groups = new Map<string, number>();
  const { data: all } = await sb.from('gainers_v1_shadow_signals')
    .select('decision, gate_result, outcome, status, reason, skip_reason')
    .gte('created_at', SINCE);
  for (const r of (all ?? [])) {
    const key = String(r.decision ?? r.gate_result ?? r.outcome ?? r.status ?? r.reason ?? r.skip_reason ?? 'unknown');
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  console.log('\n=== Group by decision/outcome ===');
  for (const [k,v] of Array.from(groups.entries()).sort((a,b)=>b[1]-a[1])) console.log(`  ${v.toString().padStart(3)} × ${k}`);
})();
