import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER_PORTFOLIO = 'b0000001-0000-0000-0000-000000000001';
  const nyseFrom = '2026-06-04T14:30:00.000Z';
  const nyseTo = '2026-06-04T21:00:00.000Z';

  console.log(`\n═══ ALL kinds in lisa_decision_log TRADER pendant NYSE ═══\n`);
  const { data: rows } = await sb
    .from('lisa_decision_log')
    .select('kind')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .gte('timestamp', nyseFrom)
    .lt('timestamp', nyseTo);
  const counts = new Map<string, number>();
  for (const r of rows ?? []) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  for (const [k, n] of [...counts].sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${n.toString().padStart(4)} × ${k}`);
  }

  // Now break down scanner_candidate_skip by verdict (real reject vs blind_pass)
  console.log(`\n═══ scanner_candidate_skip drill-down (CHOP_NOISE only) ═══\n`);
  const { data: skips } = await sb
    .from('lisa_decision_log')
    .select('payload')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .eq('kind', 'scanner_candidate_skip')
    .gte('timestamp', nyseFrom)
    .lt('timestamp', nyseTo);
  const verdictSplit = new Map<string, number>();
  const gateSplit = new Map<string, number>();
  for (const s of skips ?? []) {
    const p = s.payload as any;
    const gate = p?.gate ?? 'unknown';
    gateSplit.set(gate, (gateSplit.get(gate) ?? 0) + 1);
    if (gate === 'CHOP_NOISE') {
      const v = p?.verdict ?? 'unknown';
      verdictSplit.set(v, (verdictSplit.get(v) ?? 0) + 1);
    }
  }
  console.log('Par gate :');
  for (const [g, n] of [...gateSplit].sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${g.padEnd(20)} ${n}`);
  }
  console.log('\nCHOP_NOISE verdict split :');
  for (const [v, n] of [...verdictSplit].sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${v.padEnd(20)} ${n}  ${v === 'blind_pass' ? '(fail-open, laisse passer)' : '(VRAI skip)'}`);
  }

  // DebateGate verdict actuels
  console.log(`\n═══ DebateGate verdicts (gate=debate_gate) ═══\n`);
  const dgCounts = new Map<string, number>();
  for (const s of skips ?? []) {
    const p = s.payload as any;
    if (p?.gate === 'debate_gate') {
      const r = p?.reason ?? 'unknown';
      dgCounts.set(r, (dgCounts.get(r) ?? 0) + 1);
    }
  }
  for (const [r, n] of [...dgCounts].sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${r.padEnd(20)} ${n}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
