import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Show specifically the daily_brief (1 row, the news interpretation)
  const { data } = await sb
    .from('llm_ab_shadow_decisions')
    .select('*')
    .eq('call_site', 'daily_brief')
    .order('created_at', { ascending: false })
    .limit(3);

  for (const r of data ?? []) {
    console.log('\n' + '═'.repeat(80));
    console.log(`${r.created_at?.slice(0,19)?.replace('T',' ')} call_site=${r.call_site}`);
    console.log(`\n📰 APPLIED (${r.applied_provider}) ─ cost=$${r.applied_cost_usd?.toFixed(4)} latency=${r.applied_latency_ms}ms`);
    console.log(`${'─'.repeat(80)}`);
    console.log(String(r.applied_response_summary ?? ''));

    const shadows = r.shadows as any[];
    for (const s of shadows ?? []) {
      console.log(`\n🌑 SHADOW ${s.provider} (concordant=${s.concordance_full}) ─ cost=$${s.cost_usd?.toFixed(4)}`);
      console.log(`${'─'.repeat(80)}`);
      console.log(String(s.response_summary ?? '(empty)'));
    }
    console.log(`\nConcordance summary: ${JSON.stringify(r.concordance_summary)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
