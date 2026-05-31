/**
 * Régénère le daily_wrap report pour May 26, 2026 (UTC) avec le code corrigé.
 * Replicate exactement la logique MarketCloseReportService.aggregatePortfolio + insert.
 */
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

const PORTFOLIOS = [
  { id: '58439d86-3f20-4a60-82a4-307f3f252bc2', name: 'main' },
  { id: 'a0000001-0000-0000-0000-000000000001', name: 'shadow_high' },
  { id: 'a0000002-0000-0000-0000-000000000002', name: 'shadow_middle' },
  { id: 'a0000003-0000-0000-0000-000000000003', name: 'shadow_small' },
  { id: 'b0000001-0000-0000-0000-000000000001', name: 'trader_agent' },
];
const FEES_RT: Record<string, number> = {
  'crypto_major': 0.20, 'crypto_alt': 0.20,
  'us_equity_large': 0.05, 'us_equity_small_mid': 0.05,
  'eu_equity': 0.20, 'asia_equity': 0.20,
};
const DAILY_TARGET = 200;

(async () => {
  const windowStart = new Date('2026-05-26T00:00:00Z');
  const windowEnd = new Date('2026-05-27T00:00:00Z');
  const breakdown = [];

  for (const p of PORTFOLIOS) {
    const { data: closed } = await sb.from('lisa_positions')
      .select('symbol, asset_class, realized_pnl_usd, entry_notional_usd, entry_timestamp, exit_timestamp')
      .eq('portfolio_id', p.id)
      .gte('exit_timestamp', windowStart.toISOString())
      .lt('exit_timestamp', windowEnd.toISOString())
      .neq('status', 'open');

    let gross = 0, fees = 0, wins = 0, losses = 0, totalHoldMin = 0;
    let best: { symbol: string; pnl: number } | null = null;
    let worst: { symbol: string; pnl: number } | null = null;

    for (const c of (closed ?? [])) {
      const pnl = Number(c.realized_pnl_usd ?? 0);
      gross += pnl;
      if (pnl > 0) wins++; else if (pnl < 0) losses++;
      if (!best || pnl > best.pnl) best = { symbol: c.symbol, pnl };
      if (!worst || pnl < worst.pnl) worst = { symbol: c.symbol, pnl };
      const notional = Number(c.entry_notional_usd ?? 0);
      fees += (notional * (FEES_RT[c.asset_class as string] ?? 0.15)) / 100;
      if (c.entry_timestamp && c.exit_timestamp) {
        totalHoldMin += (new Date(c.exit_timestamp).getTime() - new Date(c.entry_timestamp).getTime()) / 60_000;
      }
    }

    const row = {
      portfolio_id: p.id, name: p.name,
      closed_count: closed?.length ?? 0,
      wins, losses,
      gross_pnl_usd: Number(gross.toFixed(2)),
      fees_usd: Number(fees.toFixed(2)),
      net_pnl_usd: Number((gross - fees).toFixed(2)),
      win_rate_pct: (closed?.length ?? 0) > 0 ? Number(((wins / closed!.length) * 100).toFixed(2)) : null,
      avg_pnl_per_trade_usd: (closed?.length ?? 0) > 0 ? Number((gross / closed!.length).toFixed(2)) : null,
      best_trade: best,
      worst_trade: worst,
      avg_hold_minutes: (closed?.length ?? 0) > 0 ? Number((totalHoldMin / closed!.length).toFixed(1)) : null,
    };
    breakdown.push(row);
  }

  const totalNet = breakdown.reduce((s, b) => s + b.net_pnl_usd, 0);
  const totalClosed = breakdown.reduce((s, b) => s + b.closed_count, 0);
  const sorted = [...breakdown].sort((a, b) => b.net_pnl_usd - a.net_pnl_usd);
  const winner = sorted[0]?.net_pnl_usd > 0 ? sorted[0] : null;
  const loser = sorted[sorted.length - 1]?.net_pnl_usd < 0 ? sorted[sorted.length - 1] : null;

  console.log(`\n📊 DAILY_WRAP RECALCULÉ — May 26, 2026 UTC`);
  console.log(`Window: ${windowStart.toISOString()} → ${windowEnd.toISOString()}`);
  console.log(`Total net: $${totalNet.toFixed(2)} (${totalClosed} trades) — Target $${DAILY_TARGET} (${((totalNet/DAILY_TARGET)*100).toFixed(1)}%)`);
  console.log(`Winner: ${winner?.name ?? '-'} | Loser: ${loser?.name ?? '-'}`);
  console.log('');
  for (const b of breakdown) {
    console.log(`  ${b.name.padEnd(15)} closed=${String(b.closed_count).padStart(3)} W/L=${b.wins}/${b.losses} (${b.win_rate_pct?.toFixed(1) ?? 'n/a'}%) gross=$${b.gross_pnl_usd} fees=$${b.fees_usd} net=$${b.net_pnl_usd} best=${b.best_trade?.symbol ?? '-'}/${b.best_trade?.pnl?.toFixed(2) ?? '-'} worst=${b.worst_trade?.symbol ?? '-'}/${b.worst_trade?.pnl?.toFixed(2) ?? '-'} avgHold=${b.avg_hold_minutes ?? 0}min`);
  }

  // Insert nouveau report en DB (override l'ancien)
  const { error } = await sb.from('market_close_reports').insert({
    captured_at: new Date().toISOString(),
    session_kind: 'daily_wrap',
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    portfolio_breakdown: breakdown,
    total_net_pnl_usd: totalNet.toFixed(2),
    total_closed_count: totalClosed,
    winner_portfolio_id: winner?.portfolio_id ?? null,
    loser_portfolio_id: loser?.portfolio_id ?? null,
    target_progress_pct: ((totalNet / DAILY_TARGET) * 100).toFixed(2),
    ai_narrative: 'Régénéré manuellement post-fix closed_at→exit_timestamp (PR #477)',
  });
  console.log(`\nInsert: ${error ? 'ERROR ' + error.message : 'OK ✅'}`);
})();
