/**
 * Watch loop: polls lisa_positions for new closes and reports half-life + outcome.
 * Exits early when 3 closes observed OR after maxCycles.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((a: any, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) a[m[1]] = m[2]; return a;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const PID = 'b0000001-0000-0000-0000-000000000001';

const seen = new Set<string>();
const closedHistory: Array<{ symbol: string; direction: string; pnl: number; pnlPct: number; holdMin: number; reason: string; closedAt: string }> = [];

async function tick(i: number) {
  const now = new Date().toISOString().slice(11, 19);
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  // Fetch closed positions last 60min, detect new ones
  const { data: closed } = await sb.from('lisa_positions')
    .select('id, symbol, direction, status, entry_price, exit_price, entry_notional_usd, entry_timestamp, exit_timestamp, pnl_usd, pnl_pct, close_reason, asset_class')
    .eq('portfolio_id', PID).eq('status', 'closed')
    .gte('exit_timestamp', since)
    .order('exit_timestamp', { ascending: true });

  const news = (closed ?? []).filter((p: any) => !seen.has(p.id));
  for (const p of news as any[]) {
    seen.add(p.id);
    const hold = (new Date(p.exit_timestamp).getTime() - new Date(p.entry_timestamp).getTime()) / 60000;
    closedHistory.push({
      symbol: p.symbol, direction: p.direction, pnl: Number(p.pnl_usd ?? 0), pnlPct: Number(p.pnl_pct ?? 0),
      holdMin: hold, reason: p.close_reason ?? 'unknown', closedAt: p.exit_timestamp,
    });
    const tag = Number(p.pnl_usd) >= 0 ? '✅ WIN ' : '❌ LOSS';
    console.log(`\n${tag} ${p.exit_timestamp.slice(11, 19)} ${p.symbol.padEnd(12)} ${p.direction.padEnd(5)} entry=${p.entry_price} exit=${p.exit_price} pnl=$${Number(p.pnl_usd).toFixed(2)} (${Number(p.pnl_pct).toFixed(2)}%) held=${hold.toFixed(1)}min reason=${p.reason ?? p.close_reason}`);
  }

  // Periodic state
  const { data: open } = await sb.from('lisa_positions')
    .select('symbol').eq('portfolio_id', PID).eq('status', 'open');
  if (i % 3 === 0 || news.length) {
    console.log(`\n[${now}] open=${open?.length ?? 0}  closed_today=${closedHistory.length}`);
  }
}

(async () => {
  // Capture baseline = existing closed positions (don't re-report)
  const sinceBaseline = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: baseline } = await sb.from('lisa_positions')
    .select('id').eq('portfolio_id', PID).eq('status', 'closed')
    .gte('exit_timestamp', sinceBaseline);
  for (const p of (baseline ?? []) as any[]) seen.add(p.id);
  console.log(`Baseline: ${seen.size} closed positions already (won't re-report)`);
  console.log(`Watching for new closes (poll 30s)...\n`);

  const maxCycles = Number(process.env.MAX_CYCLES ?? 80); // 80 × 30s = 40min
  const targetCloses = Number(process.env.TARGET_CLOSES ?? 4);
  for (let i = 0; i < maxCycles; i++) {
    try { await tick(i); } catch (e: any) { console.error(`tick err: ${e.message}`); }
    if (closedHistory.length >= targetCloses) {
      console.log(`\n→ ${targetCloses} closes captured, summary:`);
      break;
    }
    await new Promise(r => setTimeout(r, 30_000));
  }

  // Summary
  if (closedHistory.length > 0) {
    const holds = closedHistory.map(c => c.holdMin);
    const sorted = [...holds].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const wins = closedHistory.filter(c => c.pnl > 0).length;
    const losses = closedHistory.filter(c => c.pnl < 0).length;
    const netPnl = closedHistory.reduce((s, c) => s + c.pnl, 0);
    const reasons: Record<string, number> = {};
    closedHistory.forEach(c => { reasons[c.reason] = (reasons[c.reason] ?? 0) + 1; });

    console.log(`\n=== HALF-LIFE & OUTCOMES (${closedHistory.length} closes) ===`);
    console.log(`Half-life median=${median.toFixed(1)}min  avg=${(holds.reduce((a, b) => a + b, 0) / holds.length).toFixed(1)}min`);
    console.log(`Min=${sorted[0].toFixed(1)}min  Max=${sorted.at(-1)!.toFixed(1)}min`);
    console.log(`Win/Loss: ${wins}W / ${losses}L (${(wins / (wins + losses) * 100).toFixed(0)}% WR)`);
    console.log(`Net PnL: $${netPnl.toFixed(2)}`);
    console.log(`Close reasons:`);
    Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(25)} ${v}`));
  } else {
    console.log(`\nNo closes observed within window.`);
  }
})();
