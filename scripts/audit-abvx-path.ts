import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // ABVX entry was 15:50:12. Cherche TOUT le contexte autour.
  const { data: logs } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary, payload')
    .eq('portfolio_id','b0000001-0000-0000-0000-000000000001')
    .gte('timestamp','2026-06-05T15:48:00Z')
    .lte('timestamp','2026-06-05T15:51:00Z')
    .order('timestamp', { ascending: true });
  console.log(`Logs autour ouverture ABVX (15:48-15:51): ${logs?.length ?? 0}`);
  for (const l of logs ?? []) {
    const isAbvx = (l.summary ?? '').includes('ABVX') || JSON.stringify(l.payload ?? {}).includes('ABVX');
    if (isAbvx) {
      console.log(`  ${l.timestamp.slice(11,19)} [${l.kind}]`);
      console.log(`    summary: ${(l.summary ?? '').slice(0,200)}`);
      const p = l.payload as any;
      if (p) {
        const keys = Object.keys(p).slice(0, 15);
        for (const k of keys) console.log(`    ${k}: ${JSON.stringify(p[k]).slice(0,100)}`);
      }
      console.log();
    }
  }
  
  // Y a-t-il une scanner_proposal pour ABVX ?
  const { data: props } = await sb.from('scanner_proposals')
    .select('*')
    .eq('symbol','ABVX.US')
    .gte('proposed_at','2026-06-05T15:00:00Z')
    .order('proposed_at', { ascending: false });
  console.log(`\nscanner_proposals ABVX.US aujourd'hui: ${props?.length ?? 0}`);
  for (const p of props ?? []) {
    console.log(`  ${p.proposed_at} pf=${p.portfolio_id?.slice(0,12)} score=${p.score} status=${p.status ?? '?'} reasoning=${(p.scanner_reasoning ?? '').slice(0,100)}`);
  }
}
main().catch(console.error);
