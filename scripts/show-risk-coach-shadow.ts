import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  for (const site of ['risk_monitor', 'strategy_coach']) {
    console.log('\n' + '═'.repeat(80));
    console.log(`call_site = ${site}`);
    console.log('═'.repeat(80));
    const { data } = await sb.from('llm_ab_shadow_decisions').select('*').eq('call_site', site).order('created_at', { ascending: false }).limit(2);
    for (const r of data ?? []) {
      console.log(`\n${r.created_at?.slice(0,19)?.replace('T',' ')} applied=${r.applied_provider}`);
      console.log(`  APPLIED OUTPUT (${(r.applied_response_summary ?? '').length} chars):`);
      console.log(`    ${String(r.applied_response_summary ?? '').slice(0, 250).replace(/\n/g, ' ')}`);
      const shadows = r.shadows as any[];
      for (const s of shadows ?? []) {
        console.log(`  SHADOW ${s.provider} (concordant=${s.concordance_full}):`);
        console.log(`    ${String(s.response_summary ?? '').slice(0, 250).replace(/\n/g, ' ')}`);
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
