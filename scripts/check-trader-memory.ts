import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';

  // 1. Total lessons trader_agent_memory
  const { data, count } = await sb
    .from('trader_agent_memory')
    .select('*', { count: 'exact' })
    .eq('portfolio_id', TRADER)
    .order('created_at', { ascending: false })
    .limit(10);
  console.log(`\n═══ trader_agent_memory total: ${count ?? 0} ═══`);
  console.log(`Last 10 lessons (by created_at desc):\n`);
  for (const m of data ?? []) {
    const txt = (m.lesson_text ?? '').slice(0, 150);
    const active = m.is_active ? '✅' : '⚪';
    console.log(`  ${m.created_at?.slice(0,16)} ${active} kind=${(m.lesson_kind ?? '?').padEnd(20)} conf=${(m.confidence ?? 0).toFixed(2)} | ${txt}`);
  }

  // 2. Last post-mortem cycle
  console.log(`\n═══ Last 5 cron post-mortem events ═══`);
  const { data: events } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id', TRADER)
    .like('kind', '%post_mortem%')
    .order('timestamp', { ascending: false })
    .limit(5);
  for (const e of events ?? []) {
    console.log(`  ${e.timestamp.slice(0,16)} ${e.kind} | ${(e.summary ?? '').slice(0,100)}`);
  }
  if ((events?.length ?? 0) === 0) console.log('  (none)');

  // 3. Manual closes recent (closed_user) — pour voir le pattern d'apprentissage
  console.log(`\n═══ Closed_user positions last 7 days ═══`);
  const since7d = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const { data: manualCloses } = await sb
    .from('lisa_positions')
    .select('symbol, entry_price, exit_price, realized_pnl_usd, realized_pnl_pct, exit_timestamp, exit_reason')
    .eq('portfolio_id', TRADER)
    .eq('status', 'closed_user')
    .gte('exit_timestamp', since7d)
    .order('exit_timestamp', { ascending: false });
  console.log(`Total manual closes 7d: ${manualCloses?.length ?? 0}`);
  for (const c of manualCloses?.slice(0, 10) ?? []) {
    const pnl = Number(c.realized_pnl_usd ?? 0);
    const pnlPct = Number(c.realized_pnl_pct ?? 0);
    console.log(`  ${c.exit_timestamp?.slice(0,16)} ${c.symbol.padEnd(14)} entry=$${c.entry_price} → exit=$${c.exit_price} pnl=$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) reason=${(c.exit_reason ?? '').slice(0,60)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
