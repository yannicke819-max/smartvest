import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = 'b0000001-0000-0000-0000-000000000001';
(async () => {
  // LLM cost tracking
  const today = '2026-05-26';
  const { data: costs } = await sb.from('llm_cost_log')
    .select('cost_usd, model, created_at')
    .gte('created_at', `${today}T00:00:00Z`)
    .order('created_at', { ascending: false })
    .limit(10);
  const total = (costs ?? []).reduce((s,r)=>s+Number(r.cost_usd ?? 0), 0);
  console.log(`LLM cost today: $${total.toFixed(4)} on ${costs?.length ?? 0} calls`);
  
  // Tables possibly with the cost
  for (const t of ['lisa_llm_calls', 'llm_usage', 'cost_tracker', 'daily_cost_log']) {
    try {
      const { data, error } = await sb.from(t).select('*').limit(1);
      if (!error) console.log(`Table exists: ${t} (1st row keys: ${Object.keys(data?.[0] ?? {}).join(',')})`);
    } catch {}
  }

  // ANY decision_log post-deploy ANY pid
  const { data: dl } = await sb.from('lisa_decision_log')
    .select('timestamp, portfolio_id, kind, summary')
    .gte('timestamp', '2026-05-26T17:05:34Z')
    .order('timestamp', { ascending: false })
    .limit(10);
  console.log(`\nALL decision_log post-deploy: ${dl?.length ?? 0}`);
  for (const e of (dl ?? [])) {
    console.log(`  ${e.timestamp?.slice(11,19)} pid=${e.portfolio_id?.slice(0,8)} [${e.kind}] ${(e.summary ?? '').slice(0,80)}`);
  }

  // Latest persistence_log
  const { data: gpl } = await sb.from('gainers_persistence_log')
    .select('captured_at')
    .order('captured_at', { ascending: false }).limit(5);
  console.log(`\nLatest 5 persistence_log captures:`);
  for (const r of (gpl ?? [])) console.log(`  ${r.captured_at}`);
})();
