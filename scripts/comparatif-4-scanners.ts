/**
 * Comparatif COMPLET des 4 scanners SmartVest paper-trading.
 *
 * Pour chaque portfolio :
 *   - PnL réalisé (today + 7d + all-time)
 *   - PnL unrealized (positions ouvertes × live price)
 *   - Fees estimés round-trip par asset class
 *   - Net PnL (réalisé - fees + unrealized)
 *   - Win rate, avg PnL/trade, best/worst trade
 *   - Distribution par asset class
 *   - Avg hold duration
 *   - Target progress vs $200/jour
 */
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

const PORTFOLIOS = [
  { id: 'b0000001-0000-0000-0000-000000000001', name: 'MAIN',   capital: 10500 },
  { id: 'a0000001-0000-0000-0000-000000000001', name: 'HIGH',   capital: 10500 },
  { id: 'a0000002-0000-0000-0000-000000000002', name: 'MIDDLE', capital: 10500 },
  { id: 'a0000003-0000-0000-0000-000000000003', name: 'SMALL',  capital: 10500 },
];

const FEES_RT_PCT: Record<string, number> = {
  'crypto_major': 0.20, 'crypto_alt': 0.20,
  'us_equity_large': 0.05, 'us_equity_small_mid': 0.05,
  'eu_equity': 0.20, 'asia_equity': 0.20,
};

const DAILY_TARGET = 200;

function fmt(n: number | null | undefined, w = 8, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '   n/a  '.padStart(w);
  const v = Number(n);
  const s = v >= 0 ? `+${v.toFixed(decimals)}` : v.toFixed(decimals);
  return s.padStart(w);
}

function fmtPct(n: number | null | undefined, w = 6): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '  n/a'.padStart(w);
  return `${Number(n).toFixed(1)}%`.padStart(w);
}

async function analyzePortfolio(pid: string, capital: number) {
  const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();

  // Open positions
  const { data: open } = await sb.from('lisa_positions')
    .select('symbol, asset_class, direction, entry_price, entry_notional_usd, entry_timestamp')
    .eq('portfolio_id', pid).eq('status', 'open');

  // Closed today
  const { data: closedToday } = await sb.from('lisa_positions')
    .select('symbol, asset_class, direction, entry_notional_usd, realized_pnl_usd, exit_reason, entry_timestamp, exit_timestamp')
    .eq('portfolio_id', pid).gte('exit_timestamp', todayStart).neq('status', 'open');

  // Closed 7d
  const { data: closed7d } = await sb.from('lisa_positions')
    .select('symbol, asset_class, realized_pnl_usd, entry_notional_usd')
    .eq('portfolio_id', pid).gte('exit_timestamp', sevenDaysAgo).neq('status', 'open');

  // Closed all-time
  const { data: closedAll } = await sb.from('lisa_positions')
    .select('symbol, asset_class, realized_pnl_usd, entry_notional_usd', { count: 'exact' })
    .eq('portfolio_id', pid).neq('status', 'open');

  function aggregate(rows: Array<{ asset_class?: string|null; realized_pnl_usd?: string|number|null; entry_notional_usd?: string|number|null }> | null) {
    if (!rows) return { count: 0, gross: 0, fees: 0, net: 0, wins: 0, losses: 0, byClass: new Map<string, { n: number; pnl: number }>() };
    let gross = 0, fees = 0, wins = 0, losses = 0;
    const byClass = new Map<string, { n: number; pnl: number }>();
    for (const r of rows) {
      const pnl = Number(r.realized_pnl_usd ?? 0);
      gross += pnl;
      if (pnl > 0) wins++; else if (pnl < 0) losses++;
      const notional = Number(r.entry_notional_usd ?? 0);
      const cls = String(r.asset_class ?? 'unknown');
      const feesPct = FEES_RT_PCT[cls] ?? 0.15;
      fees += (notional * feesPct) / 100;
      const prev = byClass.get(cls) ?? { n: 0, pnl: 0 };
      byClass.set(cls, { n: prev.n + 1, pnl: prev.pnl + pnl });
    }
    return { count: rows.length, gross, fees, net: gross - fees, wins, losses, byClass };
  }

  const today = aggregate(closedToday);
  const wk = aggregate(closed7d);
  const all = aggregate(closedAll);

  // Best/worst today
  const sorted = (closedToday ?? []).sort((a, b) => Number(b.realized_pnl_usd ?? 0) - Number(a.realized_pnl_usd ?? 0));
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  // Avg hold duration today (min)
  let totalHoldMin = 0;
  for (const c of (closedToday ?? [])) {
    if (c.entry_timestamp && c.exit_timestamp) {
      totalHoldMin += (new Date(c.exit_timestamp).getTime() - new Date(c.entry_timestamp).getTime()) / 60_000;
    }
  }
  const avgHoldMin = today.count > 0 ? totalHoldMin / today.count : null;

  // Open positions: notional total + unrealized (best-effort using last known price = entry_price for now)
  const openCount = open?.length ?? 0;
  const deployedUsd = (open ?? []).reduce((s, p) => s + Number(p.entry_notional_usd ?? 0), 0);

  return {
    pid, capital,
    today, wk, all,
    openCount, deployedUsd,
    best, worst, avgHoldMin,
    winRateTodayPct: today.count > 0 ? (today.wins / today.count) * 100 : null,
    winRate7dPct: wk.count > 0 ? (wk.wins / wk.count) * 100 : null,
    winRateAllPct: all.count > 0 ? (all.wins / all.count) * 100 : null,
    avgPnlPerTradeToday: today.count > 0 ? today.net / today.count : null,
    avgPnlPerTrade7d: wk.count > 0 ? wk.net / wk.count : null,
    targetProgressPct: (today.net / DAILY_TARGET) * 100,
  };
}

(async () => {
  const t = new Date();
  console.log(`\n╔══════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  COMPARATIF COMPLET 4 SCANNERS — ${t.toISOString().slice(0, 19)} UTC               ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════════════╝\n`);

  const results = [];
  for (const p of PORTFOLIOS) {
    const r = await analyzePortfolio(p.id, p.capital);
    results.push({ ...r, name: p.name });
  }

  // ====== TABLE 1 : TODAY ======
  console.log(`📊 PERFORMANCE TODAY (${t.toISOString().slice(0, 10)} UTC)`);
  console.log('─'.repeat(95));
  console.log(`${'Portfolio'.padEnd(10)} | ${'Closed'.padStart(7)} | ${'Wins/Loss'.padStart(10)} | ${'Win%'.padStart(6)} | ${'Gross$'.padStart(8)} | ${'Fees$'.padStart(7)} | ${'Net$'.padStart(8)} | ${'$/trade'.padStart(8)} | ${'Target'.padStart(7)}`);
  console.log('─'.repeat(95));
  for (const r of results) {
    console.log(
      `${r.name.padEnd(10)} | ${String(r.today.count).padStart(7)} | ${(r.today.wins + '/' + r.today.losses).padStart(10)} | ${fmtPct(r.winRateTodayPct, 6)} | ${fmt(r.today.gross, 8)} | ${fmt(r.today.fees, 7)} | ${fmt(r.today.net, 8)} | ${fmt(r.avgPnlPerTradeToday, 8)} | ${fmtPct(r.targetProgressPct, 7)}`
    );
  }
  const totalNetToday = results.reduce((s, r) => s + r.today.net, 0);
  console.log('─'.repeat(95));
  console.log(`${'TOTAL'.padEnd(10)} | ${String(results.reduce((s, r) => s + r.today.count, 0)).padStart(7)} | ${'-'.padStart(10)} | ${'-'.padStart(6)} | ${fmt(results.reduce((s,r)=>s+r.today.gross,0), 8)} | ${fmt(results.reduce((s,r)=>s+r.today.fees,0), 7)} | ${fmt(totalNetToday, 8)} | ${'-'.padStart(8)} | ${fmtPct((totalNetToday/DAILY_TARGET)*100, 7)}`);

  // ====== TABLE 2 : 7 DAYS ======
  console.log(`\n📊 PERFORMANCE 7 DERNIERS JOURS`);
  console.log('─'.repeat(80));
  console.log(`${'Portfolio'.padEnd(10)} | ${'Closed'.padStart(7)} | ${'Wins/Loss'.padStart(10)} | ${'Win%'.padStart(6)} | ${'Net$'.padStart(8)} | ${'$/trade'.padStart(8)}`);
  console.log('─'.repeat(80));
  for (const r of results) {
    console.log(
      `${r.name.padEnd(10)} | ${String(r.wk.count).padStart(7)} | ${(r.wk.wins + '/' + r.wk.losses).padStart(10)} | ${fmtPct(r.winRate7dPct, 6)} | ${fmt(r.wk.net, 8)} | ${fmt(r.avgPnlPerTrade7d, 8)}`
    );
  }

  // ====== TABLE 3 : ALL TIME ======
  console.log(`\n📊 PERFORMANCE ALL-TIME (depuis création portfolio)`);
  console.log('─'.repeat(75));
  console.log(`${'Portfolio'.padEnd(10)} | ${'Closed'.padStart(7)} | ${'Wins/Loss'.padStart(10)} | ${'Win%'.padStart(6)} | ${'Net$'.padStart(10)}`);
  console.log('─'.repeat(75));
  for (const r of results) {
    console.log(
      `${r.name.padEnd(10)} | ${String(r.all.count).padStart(7)} | ${(r.all.wins + '/' + r.all.losses).padStart(10)} | ${fmtPct(r.winRateAllPct, 6)} | ${fmt(r.all.net, 10)}`
    );
  }

  // ====== TABLE 4 : OPEN POSITIONS ======
  console.log(`\n📊 POSITIONS OUVERTES — exposure live`);
  console.log('─'.repeat(70));
  console.log(`${'Portfolio'.padEnd(10)} | ${'Open'.padStart(5)} | ${'Deployed $'.padStart(12)} | ${'Capital $'.padStart(10)} | ${'Util%'.padStart(7)}`);
  console.log('─'.repeat(70));
  for (const r of results) {
    const util = r.deployedUsd / r.capital * 100;
    console.log(
      `${r.name.padEnd(10)} | ${String(r.openCount).padStart(5)} | ${fmt(r.deployedUsd, 12)} | ${fmt(r.capital, 10)} | ${fmtPct(util, 7)}`
    );
  }

  // ====== TABLE 5 : BREAKDOWN PAR ASSET CLASS TODAY ======
  console.log(`\n📊 BREAKDOWN PAR ASSET CLASS (today)`);
  console.log('─'.repeat(90));
  for (const r of results) {
    if (r.today.count === 0) {
      console.log(`${r.name.padEnd(10)} : aucun trade fermé aujourd'hui`);
      continue;
    }
    const lines: string[] = [];
    for (const [cls, info] of r.today.byClass.entries()) {
      lines.push(`${cls}=${info.n}cl/$${info.pnl.toFixed(2)}`);
    }
    console.log(`${r.name.padEnd(10)} : ${lines.join(' | ')}`);
  }

  // ====== TABLE 6 : BEST/WORST TRADES TODAY ======
  console.log(`\n📊 MEILLEUR / PIRE TRADE TODAY`);
  console.log('─'.repeat(70));
  console.log(`${'Portfolio'.padEnd(10)} | ${'Best'.padEnd(30)} | ${'Worst'.padEnd(30)}`);
  console.log('─'.repeat(70));
  for (const r of results) {
    const bestStr = r.best ? `${r.best.symbol} ${r.best.direction} ${fmt(Number(r.best.realized_pnl_usd))} (${r.best.exit_reason ?? '-'})` : '-';
    const worstStr = r.worst && r.worst !== r.best ? `${r.worst.symbol} ${r.worst.direction} ${fmt(Number(r.worst.realized_pnl_usd))} (${r.worst.exit_reason ?? '-'})` : '-';
    console.log(`${r.name.padEnd(10)} | ${bestStr.padEnd(30)} | ${worstStr.padEnd(30)}`);
  }

  // ====== TABLE 7 : RANKING ======
  console.log(`\n🏆 RANKING TODAY (par Net PnL après fees)`);
  console.log('─'.repeat(50));
  const ranked = [...results].sort((a, b) => b.today.net - a.today.net);
  ranked.forEach((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    console.log(`${medal} ${(i+1)}. ${r.name.padEnd(10)} ${fmt(r.today.net, 8)}  (${r.today.count}cl, ${r.openCount}op)`);
  });

  // ====== SUMMARY ======
  console.log(`\n╔══════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  RÉSUMÉ : Total net today = $${totalNetToday.toFixed(2).padStart(8)} / cible $${DAILY_TARGET} (${((totalNetToday/DAILY_TARGET)*100).toFixed(1)}%)`);
  console.log(`╚══════════════════════════════════════════════════════════════════════════════╝\n`);
})();
