import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 60 * 60_000).toISOString();

  const { data } = await sb
    .from('trader_agent_decisions')
    .select('decided_at, action_kind, gemini_provider, gemini_cost_usd, gemini_latency_ms, mistral_cost_usd, mistral_latency_ms, mistral_large_cost_usd, mistral_large_latency_ms, pro_cost_usd, pro_latency_ms, flash_cost_usd, flash_latency_ms')
    .eq('portfolio_id', TRADER)
    .gte('decided_at', since)
    .not('action_kind', 'eq', null)
    .order('decided_at', { ascending: false })
    .limit(30);

  console.log(`\n═══ Dernières ${data?.length ?? 0} décisions TRADER 60min — provider utilisé ═══\n`);
  let mistralCount = 0, geminiCount = 0, mistralLargeCount = 0, none = 0;
  for (const d of data ?? []) {
    const mist = (d.mistral_cost_usd ?? 0) > 0 || (d.mistral_latency_ms ?? 0) > 0;
    const mistL = (d.mistral_large_cost_usd ?? 0) > 0 || (d.mistral_large_latency_ms ?? 0) > 0;
    const gem = (d.gemini_cost_usd ?? 0) > 0 || (d.gemini_latency_ms ?? 0) > 0;
    const pro = (d.pro_cost_usd ?? 0) > 0 || (d.pro_latency_ms ?? 0) > 0;
    const flash = (d.flash_cost_usd ?? 0) > 0 || (d.flash_latency_ms ?? 0) > 0;
    if (mist) mistralCount++;
    if (mistL) mistralLargeCount++;
    if (gem) geminiCount++;
    if (!mist && !mistL && !gem && !pro && !flash) none++;
    const tag = mist ? '🟦MISTRAL' : mistL ? '🟦MISTRAL-LG' : gem ? '🟥GEMINI' : pro ? '🟨PRO' : flash ? '🟪FLASH' : '⚪none';
    console.log(`  ${d.decided_at?.slice(11,19)} ${d.action_kind?.padEnd(15)} ${tag.padEnd(12)} provider=${d.gemini_provider ?? '—'} costs: mist=$${(d.mistral_cost_usd ?? 0).toFixed(4)} mistL=$${(d.mistral_large_cost_usd ?? 0).toFixed(4)} gem=$${(d.gemini_cost_usd ?? 0).toFixed(4)}`);
  }

  console.log(`\nUsage breakdown (60min):`);
  console.log(`  🟦 Mistral primary    : ${mistralCount}`);
  console.log(`  🟦 Mistral large      : ${mistralLargeCount}`);
  console.log(`  🟥 Gemini called      : ${geminiCount}`);
  console.log(`  ⚪ Skip (no LLM call) : ${none}`);

  if (geminiCount > 0 && mistralCount === 0) {
    console.log(`\n⚠️  Gemini est appelé en primary, PAS Mistral. Secret LLM_PRIMARY_PROVIDER probablement absent ou ≠ 'mistral-medium'.`);
  } else if (mistralCount > 0) {
    console.log(`\n✅ Mistral est appelé en primary.`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
