import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const PID = 'b0000001-0000-0000-0000-000000000001';

(async () => {
  // Look at risk-manager events specifically
  const since = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const { data: rmEvents } = await sb.from('lisa_decision_log')
    .select('kind, summary, payload, created_at')
    .eq('portfolio_id', PID)
    .or('kind.ilike.%risk_manager%,kind.ilike.%gemini%,summary.ilike.%risk-manager%,summary.ilike.%gemini%')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(30);
  console.log(`=== RM/Gemini events last 90min: ${rmEvents?.length ?? 0} ===\n`);
  if (rmEvents) for (const e of rmEvents as any[]) {
    const p = e.payload ?? {};
    console.log(`${e.created_at.slice(11,19)}  kind=${e.kind}`);
    if (p.model) console.log(`  model=${p.model} latency=${p.latency_ms ?? p.latencyMs ?? '?'}ms cost=${p.cost_usd ?? p.costUsd ?? '?'}`);
    if (p.grounded !== undefined) console.log(`  grounded=${p.grounded}`);
    if (p.input_tokens || p.inputTokens) console.log(`  tokens in=${p.input_tokens ?? p.inputTokens} out=${p.output_tokens ?? p.outputTokens}`);
    if (e.summary) console.log(`  ${e.summary.slice(0, 150)}`);
  }

  // Check llm_call_log table if exists
  const { data: llmCalls, error: lcErr } = await sb.from('llm_call_log')
    .select('provider_id, model, latency_ms, cost_usd, input_tokens, output_tokens, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(30);
  if (lcErr) {
    console.log(`\nllm_call_log: ${lcErr.message}`);
  } else {
    console.log(`\n=== llm_call_log last 90min: ${llmCalls?.length ?? 0} ===`);
    if (llmCalls) for (const c of llmCalls as any[]) {
      console.log(`${c.created_at.slice(11,19)} provider=${c.provider_id.padEnd(20)} model=${(c.model ?? '?').padEnd(30)} lat=${String(c.latency_ms).padStart(5)}ms cost=$${Number(c.cost_usd).toFixed(6)} in/out=${c.input_tokens}/${c.output_tokens}`);
    }
  }
})();
