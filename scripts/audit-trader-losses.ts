import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const TRADER = 'b0000001-0000-0000-0000-000000000001';

async function main() {
  // 1. Tous trades TRADER all-time avec détail complet
  console.log('═══ 1. TRADER — TOUS trades all-time (détail complet) ═══');
  const { data: trades } = await sb
    .from('lisa_positions')
    .select('*')
    .eq('portfolio_id', TRADER)
    .order('entry_timestamp', { ascending: true });

  for (const t of trades ?? []) {
    const isLong = t.direction === 'long' || t.side === 'long' || t.side === 'BUY';
    const entry = Number(t.entry_price);
    const exit = Number(t.exit_price);
    const peak = Number(t.peak_pre_exit);
    const trough = Number(t.trough_pre_exit);
    const sl = Number(t.stop_loss_price);
    const tp = Number(t.take_profit_price);
    const mfePct = peak && entry ? (isLong ? (peak - entry) / entry * 100 : (entry - peak) / entry * 100) : null;
    const maePct = trough && entry ? (isLong ? (entry - trough) / entry * 100 : (trough - entry) / entry * 100) : null;
    const realPct = exit && entry ? (isLong ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100) : null;
    const slPct = sl && entry ? Math.abs((sl - entry) / entry * 100) : null;
    const tpPct = tp && entry ? Math.abs((tp - entry) / entry * 100) : null;
    const hold = t.hold_duration_seconds ? Math.round(Number(t.hold_duration_seconds) / 60) : null;

    console.log(`\n${t.entry_timestamp?.slice(0,16)?.replace('T',' ')} → ${t.exit_timestamp?.slice(11,16) ?? '-'}`);
    console.log(`  ${t.symbol} ${t.direction || t.side} class=${t.asset_class}`);
    console.log(`  entry=$${entry}  exit=$${exit}  notional=$${t.entry_notional_usd}`);
    console.log(`  SL=$${sl} (${slPct?.toFixed(2)}%)  TP=$${tp} (${tpPct?.toFixed(2)}%)`);
    console.log(`  peak=$${peak ?? '-'} (MFE ${mfePct?.toFixed(2) ?? '-'}%)  trough=$${trough ?? '-'} (MAE ${maePct?.toFixed(2) ?? '-'}%)`);
    console.log(`  realized=$${t.realized_pnl_usd} (${realPct?.toFixed(2)}%)  hold=${hold}min  exit_reason="${t.exit_reason}"`);
    if (maePct && slPct) console.log(`  MAE/R = ${(maePct/slPct).toFixed(2)} (healthy 0.6-0.85, toxic >1.5)`);
    if (mfePct && realPct && realPct > 0) console.log(`  Capture = ${(realPct/mfePct*100).toFixed(0)}% (du MFE atteint)`);
    if (mfePct && realPct && realPct < 0 && mfePct > 0) console.log(`  ❌ MFE était +${mfePct.toFixed(2)}% mais exit à ${realPct.toFixed(2)}% — let-run échec`);
  }

  // 2. Decision log TRADER autour des trades
  console.log('\n\n═══ 2. Decision logs TRADER 31/05 09:00 — 01/06 03:00 ═══');
  const { data: logs } = await sb
    .from('lisa_decision_log')
    .select('created_at, kind, payload')
    .eq('portfolio_id', TRADER)
    .gte('created_at', '2026-05-31T09:00:00Z')
    .order('created_at', { ascending: true });
  for (const l of (logs ?? []).slice(0, 100)) {
    const ps = JSON.stringify(l.payload).slice(0, 180);
    console.log(`  ${l.created_at?.slice(0,19)?.replace('T',' ')}  ${l.kind?.padEnd(40)} ${ps}`);
  }

  // 3. Lessons actives qui auraient dû s'appliquer
  console.log('\n\n═══ 3. Lessons actives au moment des trades ═══');
  const { data: lessons } = await sb
    .from('scanner_lessons')
    .select('id, lesson_kind, scope, macro_condition, lesson_text, confidence, applied')
    .eq('is_active', true)
    .in('scope', ['trader_agent_only', 'all_scanner'])
    .order('confidence', { ascending: false });
  for (const l of (lessons ?? []).slice(0, 8)) {
    console.log(`  ${l.id?.slice(0,8)} [${l.lesson_kind}] ${l.macro_condition} conf=${l.confidence} applied=${l.applied}`);
    console.log(`    ${(l.lesson_text as string)?.slice(0, 200).replace(/\n/g, ' | ')}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
