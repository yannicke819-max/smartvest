import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  // Today closed trades TRADER
  const { data: closed } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, exit_timestamp, entry_price, exit_price, peak_pre_exit, realized_pnl_usd, exit_reason')
    .eq('portfolio_id', TRADER)
    .neq('status', 'open')
    .gte('exit_timestamp', '2026-06-01T00:00:00Z')
    .order('exit_timestamp', { ascending: false });
  console.log('=== TRADER trades fermés today ===');
  for (const t of closed ?? []) {
    const pct = (Number(t.exit_price) - Number(t.entry_price)) / Number(t.entry_price) * 100;
    const mfe = t.peak_pre_exit ? (Number(t.peak_pre_exit) - Number(t.entry_price)) / Number(t.entry_price) * 100 : null;
    console.log(`  ${t.entry_timestamp?.slice(11,16)}→${t.exit_timestamp?.slice(11,16)} ${t.symbol} entry=${t.entry_price} exit=${t.exit_price} (${pct.toFixed(2)}%) MFE=${mfe?.toFixed(2)}% pnl=$${t.realized_pnl_usd} reason=${t.exit_reason}`);
  }
  // Open
  const { data: open } = await sb.from('lisa_positions').select('symbol, entry_timestamp, entry_price, entry_notional_usd').eq('portfolio_id', TRADER).eq('status', 'open');
  console.log(`\n=== TRADER positions ouvertes = ${open?.length} ===`);
  for (const p of open ?? []) {
    console.log(`  ${p.entry_timestamp?.slice(11,16)} ${p.symbol} entry=${p.entry_price} notional=$${p.entry_notional_usd}`);
  }
  // Latest cycles
  const { data: cycles } = await sb.from('gemini_ab_decisions')
    .select('decided_at, pro_action_kind, pro_target_symbol, pro_provider, mistral_action_kind, mistral_target_symbol, mistral_large_action_kind')
    .gte('decided_at', '2026-06-01T05:30:00Z')
    .order('decided_at', { ascending: false })
    .limit(8);
  console.log(`\n=== Cycles TRADER depuis 05:30 UTC ===`);
  for (const c of cycles ?? []) {
    console.log(`  ${c.decided_at?.slice(11,19)} applied_provider=${c.pro_provider} pro=${c.pro_action_kind}/${c.pro_target_symbol ?? '-'} med=${c.mistral_action_kind ?? '-'}/${c.mistral_target_symbol ?? '-'} lg=${c.mistral_large_action_kind ?? '-'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
