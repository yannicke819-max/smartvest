/**
 * verify-hour-edge-us.ts
 *
 * Vérifie si l'hour blacklist 17h/18h UTC long US sur le scanner gainers est
 * encore valide sur 7d et 30d, ou si on peut le unset côté Fly.
 *
 * Sources interrogées (cascade) :
 *   1. paper_trades : table P6+ avec asset_class 'us_equity_large' / 'us_equity_small_mid'
 *      → champ direction implicite (gainers = long uniquement)
 *   2. gainers_positions : state machine TP/SL/trailing (asset_class='equity' uniquement)
 *      → joindre via top_gainers_log pour récupérer detected_asset_class fin
 *   3. lisa_positions via top_gainers_log : fallback (cf. analyze-hours-by-class.ts)
 *
 * Output : table par heure UTC 13-21 × {n, win_rate, mean_pnl_pct, sum_pnl_usd, stop_rate}
 * pour chaque fenêtre {7d, 30d}, pour 17h/18h vs voisines.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {} as Record<string, string>);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const US_CLASSES = ['us_equity_large', 'us_equity_small_mid'];

interface TradeRow {
  hour: number;
  pnl_pct: number;
  pnl_usd: number;
  exit_reason: string | null;
  asset_class: string;
  source: string;
  opened_at: string;
}

interface HourStats {
  hour: number;
  n: number;
  winners: number;
  losers: number;
  wr: number;
  meanPnlPct: number;
  sumPnlUsd: number;
  stopCount: number;
  stopRate: number;
}

function computeStats(trades: TradeRow[]): HourStats[] {
  const buckets = new Map<number, TradeRow[]>();
  for (const t of trades) {
    if (!buckets.has(t.hour)) buckets.set(t.hour, []);
    buckets.get(t.hour)!.push(t);
  }
  const stats: HourStats[] = [];
  // Cover US session: 13h-21h UTC (pre-market open ~13:30 to close 21:00)
  for (let h = 13; h <= 21; h++) {
    const band = buckets.get(h) ?? [];
    if (band.length === 0) {
      stats.push({ hour: h, n: 0, winners: 0, losers: 0, wr: 0, meanPnlPct: 0, sumPnlUsd: 0, stopCount: 0, stopRate: 0 });
      continue;
    }
    const winners = band.filter((b) => b.pnl_usd > 0).length;
    const losers = band.filter((b) => b.pnl_usd < 0).length;
    const sumUsd = band.reduce((s, b) => s + b.pnl_usd, 0);
    const meanPct = band.reduce((s, b) => s + b.pnl_pct, 0) / band.length;
    const stops = band.filter((b) => {
      if (!b.exit_reason) return false;
      const r = b.exit_reason.toLowerCase();
      return r.includes('stop') || r === 'sl' || r === 'sl_hit' || r.includes('structure_break') || r.includes('trailing');
    }).length;
    stats.push({
      hour: h,
      n: band.length,
      winners,
      losers,
      wr: Math.round((winners * 100) / band.length),
      meanPnlPct: meanPct,
      sumPnlUsd: sumUsd,
      stopCount: stops,
      stopRate: Math.round((stops * 100) / band.length),
    });
  }
  return stats;
}

function printTable(label: string, stats: HourStats[]): void {
  console.log(`\n── ${label} ─────────────────────────────────────────────────────`);
  console.log('Hour  | n    | wr%  | mean_pnl%   | sum_$        | stop% | flag');
  console.log('------+------+------+-------------+--------------+-------+------');
  for (const s of stats) {
    if (s.n === 0) {
      console.log(`${String(s.hour).padStart(2)}h   |    0 |      |             |              |       |`);
      continue;
    }
    const isBlacklisted = s.hour === 17 || s.hour === 18;
    const isBad = s.sumPnlUsd < 0 && s.wr < 50;
    const isGood = s.sumPnlUsd > 0 && s.wr >= 50;
    const flag = isBlacklisted ? (isBad ? ' [BL][BAD]' : isGood ? ' [BL][GOOD]' : ' [BL][NEUTRAL]') : '';
    const pnlPctStr = `${s.meanPnlPct >= 0 ? '+' : ''}${s.meanPnlPct.toFixed(3)}%`;
    const sumStr = `${s.sumPnlUsd >= 0 ? '+' : ''}$${s.sumPnlUsd.toFixed(2)}`;
    console.log(
      `${String(s.hour).padStart(2)}h   | ${String(s.n).padStart(4)} | ${String(s.wr).padStart(3)}% | ${pnlPctStr.padStart(11)} | ${sumStr.padStart(12)} | ${String(s.stopRate).padStart(3)}%  |${flag}`,
    );
  }
}

async function loadPaperTrades(sinceIso: string): Promise<TradeRow[]> {
  const { data, error } = await sb
    .from('paper_trades')
    .select('opened_at, closed_at, pnl_pct, pnl_usd, asset_class, status, symbol')
    .eq('status', 'closed')
    .in('asset_class', US_CLASSES)
    .gte('opened_at', sinceIso)
    .order('opened_at', { ascending: false });
  if (error) {
    console.error('[paper_trades] error:', error.message);
    return [];
  }
  const rows = (data ?? []) as Array<{ opened_at: string; pnl_pct: number | null; pnl_usd: number | null; asset_class: string }>;
  return rows
    .filter((r) => r.pnl_usd != null && r.opened_at)
    .map((r) => ({
      hour: Number.parseInt(r.opened_at.slice(11, 13), 10),
      pnl_pct: Number(r.pnl_pct ?? 0),
      pnl_usd: Number(r.pnl_usd ?? 0),
      exit_reason: null,
      asset_class: r.asset_class,
      source: 'paper_trades',
      opened_at: r.opened_at,
    }))
    .filter((r) => Number.isFinite(r.hour));
}

async function loadGainersPositions(sinceIso: string): Promise<TradeRow[]> {
  // gainers_positions uses asset_class='equity'|'crypto' only. To know US specifically,
  // we filter by exchange (US exchanges = .US suffix in symbol or known US exchanges).
  const { data, error } = await sb
    .from('gainers_positions')
    .select('entry_at, exit_at, realized_pnl_pct, realized_pnl_usd, exit_reason, asset_class, exchange, symbol, state')
    .eq('state', 'CLOSED')
    .eq('asset_class', 'equity')
    .gte('entry_at', sinceIso)
    .order('entry_at', { ascending: false });
  if (error) {
    console.error('[gainers_positions] error:', error.message);
    return [];
  }
  const rows = (data ?? []) as Array<{
    entry_at: string;
    realized_pnl_pct: number | null;
    realized_pnl_usd: number | null;
    exit_reason: string | null;
    exchange: string;
    symbol: string;
  }>;
  // Filter for US (exchange = 'US' or 'NYSE' or 'NASDAQ' or symbol endsWith .US)
  return rows
    .filter((r) => {
      const ex = (r.exchange ?? '').toUpperCase();
      const symU = (r.symbol ?? '').toUpperCase();
      return ex === 'US' || ex === 'NYSE' || ex === 'NASDAQ' || ex === 'AMEX' || ex === 'BATS' || symU.endsWith('.US');
    })
    .filter((r) => r.realized_pnl_usd != null && r.entry_at)
    .map((r) => ({
      hour: Number.parseInt(r.entry_at.slice(11, 13), 10),
      pnl_pct: Number(r.realized_pnl_pct ?? 0) * 100, // gainers_positions stocke en fraction
      pnl_usd: Number(r.realized_pnl_usd ?? 0),
      exit_reason: r.exit_reason,
      asset_class: 'us_equity',
      source: 'gainers_positions',
      opened_at: r.entry_at,
    }))
    .filter((r) => Number.isFinite(r.hour));
}

async function loadLisaPositionsViaLog(sinceIso: string): Promise<TradeRow[]> {
  // Fallback : same shape as analyze-hours-by-class.ts but filtered to US classes + 7d/30d
  const { data: opens, error: e1 } = await sb
    .from('top_gainers_log')
    .select('symbol, detected_asset_class, opened_position_id, captured_at')
    .eq('decision', 'opened')
    .not('opened_position_id', 'is', null)
    .in('detected_asset_class', US_CLASSES)
    .gte('captured_at', sinceIso)
    .order('captured_at', { ascending: false })
    .limit(5000);
  if (e1) {
    console.error('[top_gainers_log] error:', e1.message);
    return [];
  }
  const ids = (opens ?? []).map((r: any) => r.opened_position_id).filter((x: any) => !!x);
  if (ids.length === 0) return [];
  const { data: closed, error: e2 } = await sb
    .from('lisa_positions')
    .select('id, realized_pnl_pct, realized_pnl_usd, status, entry_timestamp, exit_reason')
    .in('id', ids)
    .neq('status', 'open');
  if (e2) {
    console.error('[lisa_positions] error:', e2.message);
    return [];
  }
  const closedMap = new Map<string, { pnl_pct: number; pnl_usd: number; ts: string; exit_reason: string | null }>();
  for (const c of (closed ?? []) as any[]) {
    if (c.realized_pnl_usd != null && c.entry_timestamp) {
      closedMap.set(c.id, {
        pnl_pct: Number(c.realized_pnl_pct ?? 0),
        pnl_usd: Number(c.realized_pnl_usd ?? 0),
        ts: c.entry_timestamp,
        exit_reason: c.exit_reason ?? null,
      });
    }
  }
  const out: TradeRow[] = [];
  for (const o of (opens ?? []) as any[]) {
    const c = closedMap.get(o.opened_position_id);
    if (!c) continue;
    const h = Number.parseInt(c.ts.slice(11, 13), 10);
    if (!Number.isFinite(h)) continue;
    out.push({
      hour: h,
      pnl_pct: c.pnl_pct,
      pnl_usd: c.pnl_usd,
      exit_reason: c.exit_reason,
      asset_class: o.detected_asset_class,
      source: 'lisa_positions',
      opened_at: c.ts,
    });
  }
  return out;
}

function neighborSummary(stats: HourStats[]): string {
  const map = new Map(stats.map((s) => [s.hour, s]));
  const get = (h: number) => map.get(h);
  const fmt = (s: HourStats | undefined) =>
    !s || s.n === 0 ? `${s?.hour ?? '?'}h:no_data` : `${s.hour}h:n=${s.n}/wr=${s.wr}%/sum=${s.sumPnlUsd >= 0 ? '+' : ''}$${s.sumPnlUsd.toFixed(0)}`;
  return ['16h', '17h', '18h', '19h', '20h']
    .map((label) => fmt(get(Number.parseInt(label, 10))))
    .join(' | ');
}

async function main() {
  const now = Date.now();
  const d7 = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const d30 = new Date(now - 30 * 24 * 3600 * 1000).toISOString();

  console.log('================================================================');
  console.log('  VERIFY HOUR EDGE US LONG — blacklist 17h/18h UTC');
  console.log('================================================================');
  console.log(`now=${new Date(now).toISOString()}`);
  console.log(`window 7d  >= ${d7}`);
  console.log(`window 30d >= ${d30}\n`);

  // ── Source 1 : paper_trades ──────────────────────────────────────────────
  console.log('\n========= SOURCE 1 : paper_trades (us_equity_large + us_equity_small_mid, long) =========');
  const pt30 = await loadPaperTrades(d30);
  const pt7 = pt30.filter((r) => r.opened_at >= d7);
  console.log(`paper_trades total : 7d=${pt7.length}, 30d=${pt30.length}`);

  if (pt30.length === 0) {
    console.log('  → paper_trades VIDE pour cette analyse (us_equity_large/small_mid, 30d).');
  } else {
    const s7 = computeStats(pt7);
    const s30 = computeStats(pt30);
    printTable('paper_trades — 7d', s7);
    printTable('paper_trades — 30d', s30);
    console.log(`\n  Neighbours 7d :  ${neighborSummary(s7)}`);
    console.log(`  Neighbours 30d : ${neighborSummary(s30)}`);
  }

  // ── Source 2 : gainers_positions (US filtré par exchange) ────────────────
  console.log('\n========= SOURCE 2 : gainers_positions (equity, exchange=US/NYSE/NASDAQ, long) =========');
  const gp30 = await loadGainersPositions(d30);
  const gp7 = gp30.filter((r) => r.opened_at >= d7);
  console.log(`gainers_positions US total : 7d=${gp7.length}, 30d=${gp30.length}`);

  if (gp30.length === 0) {
    console.log('  → gainers_positions VIDE pour US sur 30d.');
  } else {
    const s7 = computeStats(gp7);
    const s30 = computeStats(gp30);
    printTable('gainers_positions US — 7d', s7);
    printTable('gainers_positions US — 30d', s30);
    console.log(`\n  Neighbours 7d :  ${neighborSummary(s7)}`);
    console.log(`  Neighbours 30d : ${neighborSummary(s30)}`);
  }

  // ── Source 3 : lisa_positions via top_gainers_log ────────────────────────
  console.log('\n========= SOURCE 3 : lisa_positions via top_gainers_log (us_equity_large + small_mid, long) =========');
  const lp30 = await loadLisaPositionsViaLog(d30);
  const lp7 = lp30.filter((r) => r.opened_at >= d7);
  console.log(`lisa_positions US total : 7d=${lp7.length}, 30d=${lp30.length}`);

  if (lp30.length === 0) {
    console.log('  → lisa_positions (via top_gainers_log filter US) VIDE sur 30d.');
  } else {
    const s7 = computeStats(lp7);
    const s30 = computeStats(lp30);
    printTable('lisa_positions US — 7d', s7);
    printTable('lisa_positions US — 30d', s30);
    console.log(`\n  Neighbours 7d :  ${neighborSummary(s7)}`);
    console.log(`  Neighbours 30d : ${neighborSummary(s30)}`);
  }

  // ── Verdict synthétique ──────────────────────────────────────────────────
  console.log('\n========= VERDICT =========');
  // Union des sources pour avoir le plus de sample
  const union7 = [...pt7, ...gp7, ...lp7];
  const union30 = [...pt30, ...gp30, ...lp30];
  console.log(`union 7d=${union7.length}, union 30d=${union30.length}`);
  if (union30.length >= 10) {
    const s7 = computeStats(union7);
    const s30 = computeStats(union30);
    printTable('UNION ALL SOURCES — 7d', s7);
    printTable('UNION ALL SOURCES — 30d', s30);

    const h17_7 = s7.find((s) => s.hour === 17);
    const h18_7 = s7.find((s) => s.hour === 18);
    const h17_30 = s30.find((s) => s.hour === 17);
    const h18_30 = s30.find((s) => s.hour === 18);
    console.log('\n  17h UTC :');
    console.log(`    7d  → ${h17_7 ? `n=${h17_7.n}, wr=${h17_7.wr}%, sum=$${h17_7.sumPnlUsd.toFixed(2)}, stop=${h17_7.stopRate}%` : 'no data'}`);
    console.log(`    30d → ${h17_30 ? `n=${h17_30.n}, wr=${h17_30.wr}%, sum=$${h17_30.sumPnlUsd.toFixed(2)}, stop=${h17_30.stopRate}%` : 'no data'}`);
    console.log('  18h UTC :');
    console.log(`    7d  → ${h18_7 ? `n=${h18_7.n}, wr=${h18_7.wr}%, sum=$${h18_7.sumPnlUsd.toFixed(2)}, stop=${h18_7.stopRate}%` : 'no data'}`);
    console.log(`    30d → ${h18_30 ? `n=${h18_30.n}, wr=${h18_30.wr}%, sum=$${h18_30.sumPnlUsd.toFixed(2)}, stop=${h18_30.stopRate}%` : 'no data'}`);
  } else {
    console.log('  Sample union insuffisant (<10) sur 30d → décision NON tranchable par cette analyse.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
