/**
 * Validate Gemini Risk Manager Grounding from DB persisted assessments.
 *
 * Grounding=true signature :
 *   - model field in payload = 'gemini-2.5-flash' (au lieu de 'flash-lite')
 *   - llm_cost_usd ≈ 3-6× supérieur (pricing flash vs flash-lite)
 *   - latency_ms ≈ 1500-3000ms (vs 500-900ms sans grounding)
 *
 * Note : payload n'inclut PAS model/latency par défaut dans persistAssessment.
 * → Validation indirecte via llm_cost_usd uniquement.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => { const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc; }, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

(async () => {
  // Persisted RM assessments (only verdict=broken, conf>=0.7)
  const since = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  const { data } = await sb.from('lisa_decision_log')
    .select('summary, payload, timestamp')
    .eq('kind', 'risk_manager_thesis_broken')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false }).limit(20);

  console.log(`risk_manager_thesis_broken last 4h: ${data?.length ?? 0}`);
  if (!data || data.length === 0) {
    console.log('Aucun assessment persisté — grounding non validable depuis DB.');
    console.log('Validation requise via boot log Fly (chercher "grounding=true").');
    return;
  }

  for (const e of data as any[]) {
    const p = e.payload ?? {};
    const cost = p.llm_cost_usd ?? p.cost_usd ?? null;
    const verdict = p.verdict ?? '?';
    const conf = p.confidence ?? '?';
    const reason = p.reason ?? '';
    const groundedSig = cost === null ? '?' : Number(cost) > 0.0001 ? '🟢 likely grounded' : '🔴 likely flash-lite';
    console.log(`${e.timestamp?.slice(11,19)} ${(p.symbol ?? '?').padEnd(12)} verdict=${verdict} conf=${conf} cost=$${cost} ${groundedSig}`);
    if (reason) console.log(`    reason: ${reason.slice(0, 100)}`);
  }

  // Heuristic check: if cost > $0.0005 per call, grounding likely active
  const costs = (data as any[]).map(e => Number(e.payload?.llm_cost_usd ?? 0)).filter(c => c > 0);
  if (costs.length > 0) {
    const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;
    console.log(`\nAvg llm_cost_usd over ${costs.length} calls: $${avgCost.toFixed(6)}`);
    console.log(`flash-lite expected: $0.00008-0.00025 per call`);
    console.log(`flash (grounded)   : $0.0005-0.0015 per call`);
    console.log(`→ verdict : ${avgCost > 0.0003 ? '🟢 GROUNDING ACTIVE' : '🔴 still flash-lite'}`);
  }
})();
