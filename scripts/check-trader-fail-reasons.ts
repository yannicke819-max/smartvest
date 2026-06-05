import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER_PORTFOLIO = 'b0000001-0000-0000-0000-000000000001';
  const nyseFrom = '2026-06-04T14:30:00.000Z';
  const nyseTo = '2026-06-04T21:00:00.000Z';

  console.log(`\n═══ position_open_failed reasons (NYSE session) ═══\n`);
  const { data: failed } = await sb
    .from('lisa_decision_log')
    .select('timestamp, payload')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .eq('kind', 'position_open_failed')
    .gte('timestamp', nyseFrom)
    .lt('timestamp', nyseTo);
  const reasonCounts = new Map<string, number>();
  const samples = new Map<string, any>();
  for (const f of failed ?? []) {
    const p = f.payload as any;
    const reason = p?.reason ?? p?.error_code ?? p?.error ?? JSON.stringify(p).slice(0,80);
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    if (!samples.has(reason)) samples.set(reason, { ts: f.timestamp, payload: p });
  }
  for (const [r, n] of [...reasonCounts].sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${n.toString().padStart(3)} × ${r}`);
    const s = samples.get(r);
    if (s) console.log(`         sample ${s.ts.slice(11,16)} : ${JSON.stringify(s.payload).slice(0, 200)}`);
  }

  console.log(`\n═══ scanner_candidate_skip reasons (NYSE session) ═══\n`);
  const { data: skipped } = await sb
    .from('lisa_decision_log')
    .select('timestamp, payload')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .eq('kind', 'scanner_candidate_skip')
    .gte('timestamp', nyseFrom)
    .lt('timestamp', nyseTo);
  const skipCounts = new Map<string, number>();
  const skipSamples = new Map<string, any>();
  for (const s of skipped ?? []) {
    const p = s.payload as any;
    const reason = p?.reason ?? p?.skip_reason ?? p?.error ?? JSON.stringify(p).slice(0,80);
    skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
    if (!skipSamples.has(reason)) skipSamples.set(reason, { ts: s.timestamp, payload: p });
  }
  for (const [r, n] of [...skipCounts].sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${n.toString().padStart(3)} × ${r}`);
    const s = skipSamples.get(r);
    if (s) console.log(`         sample ${s.ts.slice(11,16)} : ${JSON.stringify(s.payload).slice(0, 200)}`);
  }

  console.log(`\n═══ skeptic_verdict outcome distribution (NYSE session) ═══\n`);
  const { data: verdicts } = await sb
    .from('lisa_decision_log')
    .select('payload')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .eq('kind', 'skeptic_verdict')
    .gte('timestamp', nyseFrom)
    .lt('timestamp', nyseTo);
  const verdictCounts = new Map<string, number>();
  for (const v of verdicts ?? []) {
    const p = v.payload as any;
    const verdict = p?.verdict ?? p?.outcome ?? p?.decision ?? 'unknown';
    verdictCounts.set(verdict, (verdictCounts.get(verdict) ?? 0) + 1);
  }
  for (const [k, n] of [...verdictCounts].sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${n.toString().padStart(3)} × ${k}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
