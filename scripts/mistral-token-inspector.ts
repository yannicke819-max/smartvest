/**
 * (B) Inspecteur token Mistral — pour 5-10 calls récents, breakdown :
 *   prompt_tokens / cached_tokens / completion_tokens / costUsd
 *
 * Permet de vérifier :
 *   - cached_tokens est-il bien soustrait du prompt_tokens fresh ?
 *   - le calcul costUsd matche-t-il la formule pricing-aware ?
 *   - latency cohérente (~1-3s pour Medium, plus pour Large)
 *
 * Notre stockage actuel ne persiste PAS les tokens raw (juste cost_usd
 * agrégé). Donc on doit relancer un call live + dump le full response
 * Mistral pour comparer.
 *
 * Plus simple : lire les logs Fly (kind 'llm_call_emitted' ou similaire)
 * si on persist les tokens. Sinon : juste sortir les couts unitaires
 * observés et reverse-engineer les volumes via les prix officiels.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const since = new Date(Date.now() - 6 * 3600_000).toISOString();

// Prix officiels Mistral (cf. mistral-shadow.service.ts MISTRAL_PRICING)
const PRICES: Record<string, { input: number; output: number; cached: number }> = {
  'mistral-medium': { input: 0.40, output: 2.00, cached: 0.10 },
  'mistral-large':  { input: 2.00, output: 6.00, cached: 0.50 },
  'mistral-small':  { input: 0.10, output: 0.30, cached: 0.025 },
};

(async () => {
  console.log(`\n========== MISTRAL TOKEN INSPECTOR — last 6h ==========\n`);
  console.log(`Prix appliqués (par MTok) :`);
  for (const [k, p] of Object.entries(PRICES)) {
    console.log(`  ${k.padEnd(18)} input=$${p.input} cached=$${p.cached} output=$${p.output}`);
  }

  // Sample TRADER calls
  const { data: trader }: any = await sb.from('gemini_ab_decisions')
    .select('decided_at, mistral_provider, mistral_cost_usd, mistral_latency_ms, mistral_large_provider, mistral_large_cost_usd, mistral_large_latency_ms')
    .gte('decided_at', since).order('decided_at', { ascending: false }).limit(10);

  console.log(`\n--- TRADER calls last 6h (top 10) ---`);
  console.log('decided_at'.padEnd(22) + 'medium $'.padStart(12) + 'medLat'.padStart(8) + 'large $'.padStart(12) + 'lgLat'.padStart(8));
  for (const r of trader ?? []) {
    console.log(
      String(r.decided_at).slice(11, 19).padEnd(22) +
      (r.mistral_cost_usd != null ? '$' + Number(r.mistral_cost_usd).toFixed(6) : '-').padStart(12) +
      String(r.mistral_latency_ms ?? '-').padStart(8) +
      (r.mistral_large_cost_usd != null ? '$' + Number(r.mistral_large_cost_usd).toFixed(6) : '-').padStart(12) +
      String(r.mistral_large_latency_ms ?? '-').padStart(8)
    );
  }

  // Reverse-engineer volumes (assume zero cached + typical 80/20 split)
  console.log('\n--- REVERSE-ENGINEERING TOKENS (assume 0 cached, 100% fresh input) ---');
  console.log('Pour chaque call, si cost = fresh_in × Pi + out × Po, et qu\'on suppose ratio out/in = 0.05 (typical) :');
  for (const m of ['mistral-medium', 'mistral-large'] as const) {
    const p = PRICES[m];
    // cost = in × Pi/1e6 + 0.05*in × Po/1e6  =>  in = cost / ((Pi + 0.05*Po) / 1e6)
    const eqDivisor = (p.input + 0.05 * p.output) / 1e6;
    console.log(`  ${m}: in_tokens ≈ cost / $${eqDivisor.toExponential(2)} (assumes 5% output ratio)`);
  }

  // Sample shadow rows (more granular)
  const { data: shadows }: any = await sb.from('llm_ab_shadow_decisions')
    .select('decided_at, call_site, applied_provider, applied_cost_usd, applied_latency_ms, shadows')
    .gte('decided_at', since).order('decided_at', { ascending: false }).limit(8);

  console.log(`\n--- SHADOWS last 6h (top 8 — granulaire par site) ---`);
  for (const r of shadows ?? []) {
    console.log(`\n[${String(r.decided_at).slice(11, 19)}] site=${r.call_site} applied=${r.applied_provider} cost=$${Number(r.applied_cost_usd ?? 0).toFixed(6)} lat=${r.applied_latency_ms}ms`);
    for (const sh of (r.shadows ?? []) as any[]) {
      console.log(`    shadow ${sh.provider}: cost=$${Number(sh.cost_usd ?? 0).toFixed(6)} lat=${sh.latency_ms}ms err=${sh.error ?? '-'}`);
    }
  }

  // 24h aggregation cross-check
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: agg }: any = await sb.from('gemini_ab_decisions')
    .select('mistral_cost_usd, mistral_large_cost_usd')
    .gte('decided_at', since24h);
  let medSum = 0, lgSum = 0, medN = 0, lgN = 0;
  for (const r of agg ?? []) {
    if (r.mistral_cost_usd != null) { medSum += Number(r.mistral_cost_usd); medN++; }
    if (r.mistral_large_cost_usd != null) { lgSum += Number(r.mistral_large_cost_usd); lgN++; }
  }
  console.log(`\n--- TRADER agg 24h ---`);
  console.log(`  mistral-medium: ${medN} calls, total $${medSum.toFixed(4)}, avg $${(medSum / Math.max(1, medN)).toFixed(6)}/call`);
  console.log(`  mistral-large : ${lgN} calls, total $${lgSum.toFixed(4)}, avg $${(lgSum / Math.max(1, lgN)).toFixed(6)}/call`);

  console.log('\n========== END ==========\n');
})();
