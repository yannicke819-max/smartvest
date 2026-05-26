import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';
const SINCE = '2026-05-26T17:50:00Z';
(async () => {
  // ACCEPT shadow
  const { data: acc } = await sb.from('gainers_v1_shadow_signals')
    .select('created_at, symbol, asset_class, composite_score, entry_path_eff, decision, reject_reason, setup_type')
    .gte('created_at', SINCE)
    .eq('decision', 'ACCEPT')
    .order('created_at', { ascending: false });
  console.log(`ACCEPT shadows since 17:50: ${acc?.length ?? 0}`);
  for (const r of (acc ?? [])) console.log(`  ${r.created_at?.slice(11,19)}  ${r.symbol.padEnd(15)} ${r.asset_class?.padEnd(8)} comp=${r.composite_score} pathEff=${r.entry_path_eff?.toFixed?.(2) ?? '-'}`);

  // Group reject reasons
  const { data: all } = await sb.from('gainers_v1_shadow_signals').select('decision, reject_reason').gte('created_at', SINCE);
  const counts = new Map<string, number>();
  for (const r of (all ?? [])) {
    const k = r.decision === 'ACCEPT' ? 'ACCEPT' : (r.reject_reason ?? 'REJECT_unknown');
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  console.log('\nDecision summary since 17:50:');
  for (const [k,v] of Array.from(counts.entries()).sort((a,b)=>b[1]-a[1])) console.log(`  ${v.toString().padStart(3)} × ${k}`);

  // lisa_decision_log since 17:50
  const { data: dl } = await sb.from('lisa_decision_log').select('timestamp, kind, summary').eq('portfolio_id', PID).gte('timestamp', SINCE).order('timestamp', { ascending: false }).limit(20);
  console.log(`\ndecision_log since 17:50: ${dl?.length ?? 0}`);
  for (const e of (dl ?? [])) console.log(`  ${e.timestamp?.slice(11,19)} [${e.kind}] ${(e.summary ?? '').slice(0,100)}`);

  // user_shadow
  const { data: us } = await sb.from('gainers_user_shadow_signals').select('created_at, symbol, decision').gte('created_at', SINCE).order('created_at', { ascending: false }).limit(20);
  console.log(`\nuser_shadow_signals since 17:50: ${us?.length ?? 0}`);
  for (const r of (us ?? [])) console.log(`  ${r.created_at?.slice(11,19)} ${r.symbol} decision=${r.decision}`);
})();
