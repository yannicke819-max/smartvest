import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // trader_agent_decisions autour de 15:48-15:51 sur TRADER
  const { data } = await sb.from('trader_agent_decisions')
    .select('decided_at, action_kind, gemini_parsed, gemini_provider, gemini_raw_response, input_candidates')
    .eq('portfolio_id','b0000001-0000-0000-0000-000000000001')
    .gte('decided_at','2026-06-05T15:45:00Z')
    .lte('decided_at','2026-06-05T15:55:00Z')
    .order('decided_at', { ascending: true });
  console.log(`trader_agent_decisions 15:45-15:55 : ${data?.length ?? 0}`);
  for (const d of data ?? []) {
    console.log(`\n  ${d.decided_at.slice(11,19)} action=${d.action_kind} provider=${d.gemini_provider}`);
    const cand = (d as any).input_candidates;
    if (Array.isArray(cand)) {
      const abvx = cand.find((c:any) => c?.symbol === 'ABVX.US');
      if (abvx) console.log(`    ABVX in candidates: ${JSON.stringify(abvx).slice(0,200)}`);
    }
    const parsed = (d as any).gemini_parsed;
    if (parsed && JSON.stringify(parsed).includes('ABVX')) {
      console.log(`    parsed contains ABVX: ${JSON.stringify(parsed).slice(0,300)}`);
    }
  }
}
main().catch(console.error);
