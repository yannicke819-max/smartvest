import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';

  // 1. Les 2 trades en détail
  console.log('═══ 1. Détail complet 2 trades ═══');
  const { data: trades } = await sb.from('lisa_positions').select('*')
    .in('symbol', ['216080.KQ', '601991.SHG'])
    .eq('portfolio_id', TRADER)
    .gte('entry_timestamp', '2026-06-01T06:00:00Z')
    .order('entry_timestamp', { ascending: true });
  for (const t of trades ?? []) {
    console.log(`\n${t.symbol} (${t.asset_class})`);
    console.log(`  entry: ${t.entry_timestamp} @ $${t.entry_price} notional=$${t.entry_notional_usd}`);
    console.log(`  exit:  ${t.exit_timestamp} @ $${t.exit_price} status=${t.status}`);
    console.log(`  pnl=$${t.realized_pnl_usd} (${((Number(t.exit_price)-Number(t.entry_price))/Number(t.entry_price)*100).toFixed(2)}%)`);
    console.log(`  MFE peak=$${t.peak_pre_exit ?? '-'} MAE trough=$${t.trough_pre_exit ?? '-'}`);
    console.log(`  SL=$${t.stop_loss_price} TP=$${t.take_profit_price}`);
    console.log(`  exit_reason: ${(t.exit_reason as string)?.slice(0,200)}`);
  }

  // 2. Cycles TRADER autour de l'ouverture 06:30-06:35 UTC
  console.log('\n═══ 2. Cycles TRADER autour 06:30 UTC ═══');
  const { data: cycles } = await sb.from('gemini_ab_decisions').select('*')
    .gte('decided_at', '2026-06-01T06:25:00Z')
    .lte('decided_at', '2026-06-01T06:50:00Z')
    .order('decided_at', { ascending: true });
  for (const c of cycles ?? []) {
    const t = c.decided_at?.slice(11,19);
    console.log(`\n${t} applied=${c.pro_provider}`);
    console.log(`  Pro    ${c.pro_action_kind}/${c.pro_target_symbol ?? '-'} conf=${c.pro_confidence ?? '-'}  thesis: ${(c.pro_thesis as string)?.slice(0,150) ?? '-'}`);
    console.log(`  Flash  ${c.flash_action_kind ?? '-'}/${c.flash_target_symbol ?? '-'}`);
    console.log(`  Med    ${c.mistral_action_kind ?? '-'}/${c.mistral_target_symbol ?? '-'}`);
    console.log(`  Lg     ${c.mistral_large_action_kind ?? '-'}/${c.mistral_large_target_symbol ?? '-'}`);
  }

  // 3. Lessons actives qui mentionnent "pre-cloche" ou "$190"
  console.log('\n═══ 3. Lessons citées dans exit_reason ═══');
  const { data: lessons } = await sb.from('scanner_lessons')
    .select('id, lesson_kind, scope, macro_condition, confidence, applied, lesson_text')
    .or('lesson_text.ilike.%pre-cloche%,lesson_text.ilike.%$190%,lesson_text.ilike.%marché ferme%,lesson_text.ilike.%preflight%')
    .eq('is_active', true);
  for (const l of lessons ?? []) {
    console.log(`\n  ${l.id?.slice(0,8)} [${l.lesson_kind}] ${l.macro_condition} conf=${l.confidence} applied=${l.applied}`);
    console.log(`    ${(l.lesson_text as string)?.slice(0,300)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
