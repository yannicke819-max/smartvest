import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('gemini_ab_decisions').select('*').limit(1);
  if (data?.[0]) {
    const cols = Object.keys(data[0]);
    const outcomeFields = cols.filter(c => c.includes('outcome') || c.includes('pnl') || c.includes('resolve'));
    console.log('Outcome-related cols:', outcomeFields);
  }

  // Aggregate accuracy par LLM sur trades fermés all-time
  const { data: rows } = await sb.from('gemini_ab_decisions')
    .select('pro_action_kind, pro_target_symbol, flash_action_kind, flash_target_symbol, mistral_action_kind, mistral_target_symbol, mistral_large_action_kind, mistral_large_target_symbol, outcome_position_id, outcome_pnl_usd, outcome_win, outcome_resolved_at')
    .not('outcome_resolved_at', 'is', null);
  console.log(`\nCycles avec outcome résolu = ${rows?.length}`);
  if (rows && rows.length > 0) {
    for (const r of rows.slice(0, 5)) {
      console.log(`\n  pro=${r.pro_action_kind}/${r.pro_target_symbol ?? '-'}  flash=${r.flash_action_kind ?? '-'}/${r.flash_target_symbol ?? '-'}  med=${r.mistral_action_kind ?? '-'}/${r.mistral_target_symbol ?? '-'}  lg=${r.mistral_large_action_kind ?? '-'}/${r.mistral_large_target_symbol ?? '-'}`);
      console.log(`    outcome: position=${(r.outcome_position_id as string)?.slice(0,8)} pnl=$${r.outcome_pnl_usd} win=${r.outcome_win}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
