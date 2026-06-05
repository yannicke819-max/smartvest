import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 30 * 60_000).toISOString();

  // FULL payload des skeptic_verdict CMCX
  const { data: skeptics } = await sb
    .from('lisa_decision_log')
    .select('timestamp, payload')
    .eq('portfolio_id', TRADER)
    .eq('kind', 'skeptic_verdict')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(3);
  console.log('═══ Skeptic verdicts CMCX (FULL payload) ═══\n');
  for (const s of skeptics ?? []) {
    const p = s.payload as any;
    console.log(`${s.timestamp.slice(11,19)} verdict_veto=${p?.verdict_veto} verdict_score=${p?.verdict_score}`);
    console.log('  features:', JSON.stringify(p?.features));
    console.log('  reasons:');
    for (const r of p?.reasons ?? []) {
      console.log(`    - ${r.rule.padEnd(15)} mode=${r.mode.padEnd(10)} severity=${r.severity.padEnd(7)} triggered=${r.triggered} | ${r.detail}`);
    }
    console.log('');
  }

  // Search for ALL kinds touching CMCX in last hour
  const sinceHour = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data: allCmcx } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, summary, payload')
    .gte('timestamp', sinceHour)
    .or('summary.like.%CMCX%,payload->>symbol.eq.CMCX.LSE')
    .order('timestamp', { ascending: false })
    .limit(20);
  console.log(`\n═══ ALL events CMCX last hour : ${allCmcx?.length ?? 0} ═══\n`);
  for (const e of allCmcx ?? []) {
    console.log(`${e.timestamp.slice(11,19)} ${e.kind.padEnd(28)} ${(e.summary ?? '').slice(0, 80)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
