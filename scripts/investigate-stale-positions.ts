import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';

async function main() {
  // 1. All open positions, grouped by age
  const { data: open } = await sb
    .from('paper_trades')
    .select('*')
    .eq('portfolio_id', PID)
    .eq('status', 'open')
    .order('opened_at', { ascending: false });

  const now = Date.now();
  const stats = { lt1d: 0, lt7d: 0, lt30d: 0, gt30d: 0 };
  const byAge: Record<string, number> = {};

  for (const p of open ?? []) {
    const age = (now - new Date(p.opened_at).getTime()) / 86_400_000;
    if (age < 1) stats.lt1d++;
    else if (age < 7) stats.lt7d++;
    else if (age < 30) stats.lt30d++;
    else stats.gt30d++;
  }

  console.log(`\n=== ${open?.length ?? 0} OPEN paper_trades on Sim SmartVest ===`);
  console.log(`  < 1 day   : ${stats.lt1d}`);
  console.log(`  < 7 days  : ${stats.lt7d}`);
  console.log(`  < 30 days : ${stats.lt30d}`);
  console.log(`  > 30 days : ${stats.gt30d}`);

  // 2. Sample of oldest
  console.log(`\n=== 15 OLDEST open positions ===`);
  const oldest = (open ?? []).slice().sort((a, b) => +new Date(a.opened_at) - +new Date(b.opened_at)).slice(0, 15);
  for (const p of oldest) {
    const ageDays = ((now - new Date(p.opened_at).getTime()) / 86_400_000).toFixed(1);
    console.log(`  ${p.opened_at.slice(0, 19)}  ${p.symbol.padEnd(15)} ${(p.asset_class ?? '?').padEnd(12)} dir=${p.direction} entry=${p.entry_price} SL=${p.stop_loss} TP=${p.take_profit} size=$${p.size_usd}  AGE=${ageDays}j`);
  }

  // 3. Group by asset class
  const byClass: Record<string, number> = {};
  for (const p of open ?? []) byClass[p.asset_class] = (byClass[p.asset_class] ?? 0) + 1;
  console.log(`\n=== Open positions by asset_class ===`);
  for (const [c, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(20)} ${n}`);
  }

  // 4. Check if there's a mechanical_directive or close attempt in decision_log
  const sampleSymbol = oldest[0]?.symbol;
  if (sampleSymbol) {
    console.log(`\n=== decision_log for sample stale symbol ${sampleSymbol} (last 30 events) ===`);
    const { data: logs } = await sb
      .from('lisa_decision_log')
      .select('timestamp, kind, summary, rationale')
      .eq('portfolio_id', PID)
      .or(`summary.ilike.%${sampleSymbol}%,rationale.ilike.%${sampleSymbol}%`)
      .order('timestamp', { ascending: false })
      .limit(30);
    for (const l of logs ?? []) console.log(`  ${l.timestamp.slice(0, 19)}  ${l.kind.padEnd(30)}  ${l.summary?.slice(0, 70)}`);
  }

  // 5. Stop-loss / take-profit logs that should have fired
  console.log(`\n=== Recent stop_triggered / take_profit_triggered / closed_invalidated ===`);
  const { data: closeLogs } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, summary')
    .eq('portfolio_id', PID)
    .in('kind', ['stop_triggered', 'take_profit_triggered', 'closed_invalidated', 'mechanical_close', 'sanity_bound'])
    .order('timestamp', { ascending: false })
    .limit(20);
  for (const l of closeLogs ?? []) console.log(`  ${l.timestamp.slice(0, 19)}  ${l.kind.padEnd(30)}  ${l.summary?.slice(0, 70)}`);
}
main();
