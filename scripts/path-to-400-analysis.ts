import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);

function fmt(n: number, d = 2) { return n.toFixed(d); }
function pct(n: number) { return (n * 100).toFixed(1) + '%'; }

async function main() {
  const days = 14;
  const now = Date.now();
  const sinceMs = now - days * 24 * 3600_000;
  const since = new Date(sinceMs).toISOString();

  // ---- 1. paper_trades closed ----
  const { data: trades, error } = await sb
    .from('paper_trades')
    .select('id, symbol, asset_class, opened_at, closed_at, status, entry_price, exit_price, size_usd, pnl_usd, pnl_pct, hold_duration_seconds')
    .gte('opened_at', since)
    .in('status', ['closed_tp', 'closed_sl', 'closed_manual', 'closed_thesis_broken', 'closed', 'closed_invalidated'])
    .order('opened_at', { ascending: true });

  if (error) { console.error('paper_trades error', error); }
  const closed = trades ?? [];
  console.log(`=== PAPER TRADES (closed, last ${days}d) ===`);
  console.log(`Total closed trades: ${closed.length}`);

  if (closed.length === 0) {
    console.log('No data. Trying status list distinct...');
    const { data: distinct } = await sb.from('paper_trades').select('status').limit(200);
    const set = new Set((distinct ?? []).map((r: any) => r.status));
    console.log('Distinct statuses observed (200 sample):', [...set]);
    return;
  }

  // ---- 2. Expectancy ----
  const wins = closed.filter((t: any) => Number(t.pnl_usd) > 0);
  const losses = closed.filter((t: any) => Number(t.pnl_usd) <= 0);
  const sumPnl = closed.reduce((a: number, t: any) => a + Number(t.pnl_usd ?? 0), 0);
  const sumWin = wins.reduce((a: number, t: any) => a + Number(t.pnl_usd), 0);
  const sumLoss = losses.reduce((a: number, t: any) => a + Number(t.pnl_usd), 0);
  const avgPnl = sumPnl / closed.length;
  const winRate = wins.length / closed.length;
  const avgWinner = wins.length ? sumWin / wins.length : 0;
  const avgLoser = losses.length ? sumLoss / losses.length : 0;
  const avgSize = closed.reduce((a: number, t: any) => a + Number(t.size_usd ?? 0), 0) / closed.length;
  const avgHoldSec = closed.reduce((a: number, t: any) => a + Number(t.hold_duration_seconds ?? 0), 0) / closed.length;
  const avgHoldMin = avgHoldSec / 60;

  console.log(`\n--- EXPECTANCY ---`);
  console.log(`Total PnL (${days}d): $${fmt(sumPnl)}`);
  console.log(`Avg PnL/trade: $${fmt(avgPnl, 4)}`);
  console.log(`Win rate: ${pct(winRate)}  (${wins.length}W / ${losses.length}L)`);
  console.log(`Avg winner: +$${fmt(avgWinner, 4)}`);
  console.log(`Avg loser:  $${fmt(avgLoser, 4)}`);
  console.log(`Avg size_usd: $${fmt(avgSize)}`);
  console.log(`Avg hold: ${fmt(avgHoldMin, 1)} min`);
  console.log(`Expectancy ratio (avgWin/|avgLoss|): ${avgLoser !== 0 ? fmt(Math.abs(avgWinner / avgLoser), 2) : 'n/a'}`);

  // ---- 3. Daily PnL distribution ----
  const dayBucket: Record<string, { pnl: number; n: number }> = {};
  for (const t of closed as any[]) {
    const dt = (t.closed_at || t.opened_at).slice(0, 10);
    if (!dayBucket[dt]) dayBucket[dt] = { pnl: 0, n: 0 };
    dayBucket[dt].pnl += Number(t.pnl_usd ?? 0);
    dayBucket[dt].n += 1;
  }
  const dayKeys = Object.keys(dayBucket).sort();
  console.log(`\n--- DAILY PnL DISTRIBUTION ---`);
  console.log('Date         | Trades | PnL $');
  let geq400 = 0, geq200 = 0, geq100 = 0, neg = 0, zero = 0;
  for (const k of dayKeys) {
    const b = dayBucket[k];
    console.log(`${k}   |  ${String(b.n).padStart(4)}  | ${b.pnl >= 0 ? '+' : ''}${fmt(b.pnl)}`);
    if (b.pnl >= 400) geq400++;
    if (b.pnl >= 200) geq200++;
    if (b.pnl >= 100) geq100++;
    if (b.pnl < 0) neg++;
    if (Math.abs(b.pnl) < 0.01) zero++;
  }
  const tradingDays = dayKeys.length;
  const avgTradesPerDay = closed.length / Math.max(1, tradingDays);
  const maxTradesDay = Math.max(...Object.values(dayBucket).map((b) => b.n));
  const avgDailyPnl = sumPnl / Math.max(1, tradingDays);

  console.log(`\nTrading days observed: ${tradingDays}`);
  console.log(`Avg trades/day: ${fmt(avgTradesPerDay, 1)}`);
  console.log(`Max trades/day: ${maxTradesDay}`);
  console.log(`Avg PnL/day: $${fmt(avgDailyPnl)}`);
  console.log(`Days >= $400: ${geq400} / ${tradingDays}  (${pct(geq400 / tradingDays)})`);
  console.log(`Days >= $200: ${geq200} / ${tradingDays}`);
  console.log(`Days >= $100: ${geq100} / ${tradingDays}`);
  console.log(`Days negative: ${neg} / ${tradingDays}`);
  console.log(`Days zero: ${zero} / ${tradingDays}`);

  // ---- 4. Open positions snapshot ----
  const { count: openNow } = await sb.from('paper_trades').select('*', { count: 'exact', head: true }).eq('status', 'open');
  console.log(`\n--- CAPITAL ---`);
  console.log(`Open positions now: ${openNow}`);
  const capital = 10500;
  const maxPos = 14;
  const sizePerPos = capital / maxPos;
  console.log(`Capital: $${capital}, max pos: ${maxPos}, theoretical size/pos: $${fmt(sizePerPos)}`);
  // Rotation max: if avg hold = X min, slots = maxPos, then trades/day = maxPos * (1440 / X)
  const rotationPerDay = avgHoldMin > 0 ? maxPos * (1440 / avgHoldMin) : 0;
  console.log(`Max theoretical rotation/day (maxPos × 1440/avgHoldMin): ${fmt(rotationPerDay, 0)}`);

  // ---- 5. Scanner shadow signals (gates) last 7d ----
  const since7 = new Date(now - 7 * 24 * 3600_000).toISOString();
  const { data: shadow } = await sb
    .from('gainers_user_shadow_signals')
    .select('decision')
    .gte('created_at', since7);
  const decisionCounts: Record<string, number> = {};
  for (const r of shadow ?? []) decisionCounts[(r as any).decision] = (decisionCounts[(r as any).decision] ?? 0) + 1;
  console.log(`\n--- SHADOW SIGNALS (7d) ---`);
  console.log(`Total: ${shadow?.length ?? 0}`);
  for (const [d, n] of Object.entries(decisionCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${d.padEnd(35)} ${n}`);
  }
  const accepts7 = decisionCounts['accept'] ?? 0;
  console.log(`Accept rate: ${pct(accepts7 / Math.max(1, shadow?.length ?? 1))}`);

  // ---- 6. Bottleneck: trades needed for $400/day at current expectancy ----
  console.log(`\n--- BOTTLENECK : $400/day requirement ---`);
  if (avgPnl > 0) {
    const tradesNeeded = 400 / avgPnl;
    console.log(`At current expectancy $${fmt(avgPnl, 4)}/trade -> need ${fmt(tradesNeeded, 0)} trades/day`);
    console.log(`Current avg: ${fmt(avgTradesPerDay, 1)} trades/day -> gap ×${fmt(tradesNeeded / avgTradesPerDay, 2)}`);
  } else {
    console.log(`Expectancy is non-positive ($${fmt(avgPnl, 4)}). Cannot reach $400/day by adding volume — must fix expectancy first.`);
  }

  // ---- 7. Per asset_class breakdown ----
  console.log(`\n--- BY ASSET CLASS ---`);
  const byClass: Record<string, { n: number; pnl: number; wins: number }> = {};
  for (const t of closed as any[]) {
    const k = t.asset_class || 'unknown';
    if (!byClass[k]) byClass[k] = { n: 0, pnl: 0, wins: 0 };
    byClass[k].n++;
    byClass[k].pnl += Number(t.pnl_usd ?? 0);
    if (Number(t.pnl_usd ?? 0) > 0) byClass[k].wins++;
  }
  console.log('Class                   | N    | PnL $     | WinRate | Avg/trade');
  for (const [k, v] of Object.entries(byClass).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`${k.padEnd(23)} | ${String(v.n).padStart(4)} | ${(v.pnl >= 0 ? '+' : '') + fmt(v.pnl).padStart(8)} | ${pct(v.wins / v.n).padStart(6)} | $${fmt(v.pnl / v.n, 3)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
