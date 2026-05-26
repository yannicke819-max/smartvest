import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const SINCE = '2026-05-26T17:30:00Z';
(async () => {
  const { data } = await sb.from('gainers_v1_shadow_signals')
    .select('symbol, asset_class, decision, reject_reason, composite_score, entry_path_eff, setup_type, created_at')
    .gte('created_at', SINCE)
    .order('created_at', { ascending: false });
  console.log(`${data?.length ?? 0} signals since 17:30`);
  const byReason = new Map<string, number>();
  const byDecision = new Map<string, number>();
  const byClass = new Map<string, number>();
  for (const r of (data ?? [])) {
    byReason.set(r.reject_reason ?? '<null>', (byReason.get(r.reject_reason ?? '<null>') ?? 0) + 1);
    byDecision.set(r.decision ?? '<null>', (byDecision.get(r.decision ?? '<null>') ?? 0) + 1);
    byClass.set(r.asset_class ?? '<null>', (byClass.get(r.asset_class ?? '<null>') ?? 0) + 1);
  }
  console.log('\n=== by decision ==='); for (const [k,v] of byDecision) console.log(`  ${v.toString().padStart(3)} × ${k}`);
  console.log('\n=== by reject_reason ==='); for (const [k,v] of Array.from(byReason.entries()).sort((a,b)=>b[1]-a[1])) console.log(`  ${v.toString().padStart(3)} × ${k}`);
  console.log('\n=== by asset_class ==='); for (const [k,v] of byClass) console.log(`  ${v.toString().padStart(3)} × ${k}`);

  // Top candidats avec composite_score le plus haut
  console.log('\n=== Top 15 by composite_score ===');
  const sorted = (data ?? []).filter(r => r.composite_score != null).sort((a,b) => Number(b.composite_score) - Number(a.composite_score));
  for (const r of sorted.slice(0, 15)) {
    console.log(`  ${r.created_at?.slice(11,19)} ${r.symbol?.padEnd(15)} ${r.asset_class?.padEnd(10)} comp=${r.composite_score} pathEff=${r.entry_path_eff?.toFixed?.(2) ?? '-'} setup=${r.setup_type ?? '-'} decision=${r.decision} reason=${r.reject_reason ?? '-'}`);
  }
})();
