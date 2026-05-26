import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

function fmt(n: number, d = 2) { return n.toFixed(d); }
function pct(n: number) { return (n * 100).toFixed(1) + '%'; }

async function run(label: string, since: string) {
  const { data: trades } = await sb
    .from('paper_trades')
    .select('id, asset_class, opened_at, closed_at, status, pnl_usd, size_usd, hold_duration_seconds')
    .gte('opened_at', since)
    .like('status', 'closed%');
  const closed = trades ?? [];
  if (!closed.length) { console.log(`${label}: no closed trades`); return; }
  const wins = closed.filter((t: any) => Number(t.pnl_usd) > 0);
  const losses = closed.filter((t: any) => Number(t.pnl_usd) <= 0);
  const sumPnl = closed.reduce((a, t: any) => a + Number(t.pnl_usd ?? 0), 0);
  const avgPnl = sumPnl / closed.length;
  const winRate = wins.length / closed.length;
  const avgWin = wins.length ? wins.reduce((a, t: any) => a + Number(t.pnl_usd), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t: any) => a + Number(t.pnl_usd), 0) / losses.length : 0;
  const avgHoldMin = closed.reduce((a, t: any) => a + Number(t.hold_duration_seconds ?? 0), 0) / closed.length / 60;
  console.log(`\n${label}`);
  console.log(`  N=${closed.length}  PnL total=$${fmt(sumPnl)}  avg=$${fmt(avgPnl, 3)}/trade`);
  console.log(`  WR=${pct(winRate)}  avgW=$${fmt(avgWin, 2)}  avgL=$${fmt(avgLoss, 2)}  R/R=${avgLoss !== 0 ? fmt(Math.abs(avgWin / avgLoss), 2) : 'n/a'}`);
  console.log(`  avg hold ${fmt(avgHoldMin, 1)}min`);
}

async function main() {
  const now = Date.now();
  await run('Last 14d', new Date(now - 14 * 86400_000).toISOString());
  await run('Last 7d', new Date(now - 7 * 86400_000).toISOString());
  await run('Last 3d (post-25/05 calibration)', new Date(now - 3 * 86400_000).toISOString());
  await run('Last 24h', new Date(now - 86400_000).toISOString());
}
main().catch(console.error);
