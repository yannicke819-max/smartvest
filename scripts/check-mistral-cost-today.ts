import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // 1. Mistral cost from gemini_ab_decisions today
  const { data: cycles } = await sb.from('gemini_ab_decisions')
    .select('mistral_cost_usd, mistral_large_cost_usd, flash_cost_usd, pro_cost_usd')
    .gte('decided_at', '2026-06-01T00:00:00Z');
  let sumPro=0, sumFlash=0, sumMed=0, sumLg=0;
  let nPro=0, nFlash=0, nMed=0, nLg=0;
  for (const c of cycles ?? []) {
    if (c.pro_cost_usd) { sumPro += Number(c.pro_cost_usd); nPro++; }
    if (c.flash_cost_usd) { sumFlash += Number(c.flash_cost_usd); nFlash++; }
    if (c.mistral_cost_usd) { sumMed += Number(c.mistral_cost_usd); nMed++; }
    if (c.mistral_large_cost_usd) { sumLg += Number(c.mistral_large_cost_usd); nLg++; }
  }
  console.log(`=== Cost TRADER cycles today (${cycles?.length}) ===`);
  console.log(`Pro             : ${nPro} calls, $${sumPro.toFixed(4)}`);
  console.log(`Flash           : ${nFlash} calls, $${sumFlash.toFixed(4)}`);
  console.log(`Mistral Medium  : ${nMed} calls, $${sumMed.toFixed(4)}`);
  console.log(`Mistral Large   : ${nLg} calls, $${sumLg.toFixed(4)}`);

  // 2. llm_ab_shadow_decisions cost
  const { data: shadows } = await sb.from('llm_ab_shadow_decisions')
    .select('applied_cost_usd, applied_provider, shadows')
    .gte('created_at', '2026-06-01T00:00:00Z');
  let appliedCost = 0;
  let shadowCost: Record<string, number> = {};
  for (const r of shadows ?? []) {
    appliedCost += Number(r.applied_cost_usd ?? 0);
    for (const s of (r.shadows as any[]) ?? []) {
      shadowCost[s.provider] = (shadowCost[s.provider] || 0) + Number(s.cost_usd ?? 0);
    }
  }
  console.log(`\n=== llm_ab_shadow_decisions today (${shadows?.length}) ===`);
  console.log(`Applied total (mostly Flash Lite) : $${appliedCost.toFixed(4)}`);
  for (const [k, v] of Object.entries(shadowCost)) console.log(`Shadow ${k.padEnd(20)} : $${v.toFixed(4)}`);

  // 3. Total grand
  const total = sumPro + sumFlash + sumMed + sumLg + appliedCost + Object.values(shadowCost).reduce((s,v)=>s+v, 0);
  console.log(`\n=== TOTAL today = $${total.toFixed(4)} ===`);
  console.log(`  Gemini family (Pro+Flash+Flash Lite) : $${(sumPro + sumFlash + appliedCost + (shadowCost['gemini-pro']||0) + (shadowCost['gemini-flash-lite']||0)).toFixed(4)}`);
  console.log(`  Mistral family : $${(sumMed + sumLg + (shadowCost['mistral-medium']||0) + (shadowCost['mistral-large']||0)).toFixed(4)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
