/**
 * Analyze MFE / MAE on closed lisa_positions trades since 2026-05-06.
 *
 * Sweeney (1996) framework:
 *  - MFE (Max Favorable Excursion): best unrealized profit reached
 *  - MAE (Max Adverse Excursion): worst unrealized drawdown reached
 *  - Capture Rate = realized / MFE  (for LONG winners)
 *  - MAE/R ratio  = |MAE| / SL_distance
 *  - MFE/Target   = MFE / TP_distance
 *
 * Data sources for intraday candles:
 *  - Crypto majors → Binance klines (free)
 *  - Equities      → EODHD /api/intraday  (5m, fallback 1m)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import 'dotenv/config';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const EOD_KEY = process.env.EODHD_API_KEY || '69e6325aa2c162.98850425';

const SINCE = '2026-05-06';
const HARD_LIMIT = 500;

type Trade = {
  id: string;
  portfolio_id: string;
  symbol: string;
  asset_class: string;
  direction: 'long' | 'short';
  entry_price: string;
  exit_price: string | null;
  exit_reason: string | null;
  realized_pnl_usd: string | null;
  realized_pnl_pct: string | null;
  entry_timestamp: string;
  exit_timestamp: string | null;
  stop_loss_price: string | null;
  take_profit_price: string | null;
  entry_notional_usd: string | null;
  status: string;
};

type Candle = { ts: number; high: number; low: number };

const PORTFOLIOS: Record<string, string> = {
  '58439d86-3f20-4a60-82a4-307f3f252bc2': 'MAIN',
  'a0000001-0000-0000-0000-000000000001': 'HIGH',
  'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
  'a0000003-0000-0000-0000-000000000003': 'SMALL',
  'b0000001-0000-0000-0000-000000000001': 'TRADER',
};

async function supaGet(path: string): Promise<any> {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function supaPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchTrades(): Promise<Trade[]> {
  const cols =
    'id,portfolio_id,symbol,asset_class,direction,entry_price,exit_price,exit_reason,realized_pnl_usd,realized_pnl_pct,entry_timestamp,exit_timestamp,stop_loss_price,take_profit_price,entry_notional_usd,status';
  const path = `lisa_positions?select=${cols}&status=neq.open&exit_timestamp=gte.${SINCE}&order=exit_timestamp.desc&limit=${HARD_LIMIT}`;
  return supaGet(path);
}

function categorizeExit(reason: string | null): string {
  if (!reason) return 'unknown';
  const r = reason.toLowerCase();
  if (r.includes('closed_target') || r.includes('take-profit') || r.includes('take_profit') || r.includes('tp_hit'))
    return 'TP_HIT';
  if (r.includes('closed_stop') || (r.includes('stop') && !r.includes('trail'))) return 'SL_HIT';
  if (r.includes('early-exit') || r.includes('early_exit') || r.includes('fade')) return 'early_exit_FADE';
  if (r.includes('force_close') || r.includes('force-close')) return 'force_close';
  if (r.includes('rotation')) return 'rotation';
  if (r.includes('invalidat') || r.includes('thesis_broken') || r.includes('trader-agent')) return 'closed_invalidated';
  if (r.includes('trail')) return 'trailing';
  if (r.includes('user')) return 'closed_user';
  if (r.includes('eod') || r.includes('end_of_day') || r.includes('session_close') || r.includes('orphan')) return 'eod';
  if (r.includes('duplicate')) return 'duplicate';
  return 'other';
}

/* ----------------------- Candle providers ----------------------- */

const BIN_SYMS: Record<string, string> = {
  BTCUSDT: 'BTCUSDT',
  ETHUSDT: 'ETHUSDT',
  SOLUSDT: 'SOLUSDT',
  LINKUSDT: 'LINKUSDT',
  BNBUSDT: 'BNBUSDT',
  XRPUSDT: 'XRPUSDT',
  ADAUSDT: 'ADAUSDT',
  DOGEUSDT: 'DOGEUSDT',
  AVAXUSDT: 'AVAXUSDT',
};

function normalizeCryptoForBinance(sym: string): string | null {
  // crypto symbols can be like BTCUSDT, BTC-USD.CC, etc
  const up = sym.toUpperCase();
  const stripped = up
    .replace(/\.CC$/, '')
    .replace(/\.BINANCE$/, '')
    .replace(/-/g, '');
  if (BIN_SYMS[stripped]) return stripped;
  // try replacing USD → USDT
  const usdt = stripped.endsWith('USD') ? stripped.slice(0, -3) + 'USDT' : stripped;
  if (BIN_SYMS[usdt]) return usdt;
  return stripped.endsWith('USDT') ? stripped : null;
}

function cryptoToEodhd(sym: string): string | null {
  // BTCUSDT → BTC-USD.CC ; ETHUSDT → ETH-USD.CC
  const up = sym.toUpperCase();
  if (/\.CC$/.test(up)) return up;
  const m = up.match(/^([A-Z]+)USDT?$/);
  if (m) return `${m[1]}-USD.CC`;
  return null;
}

async function fetchBinance(symbol: string, fromUnix: number, toUnix: number, interval: '1m' | '5m'): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${fromUnix * 1000}&endTime=${toUnix * 1000}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as any[];
  return data.map((k) => ({
    ts: Math.floor(k[0] / 1000),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
  }));
}

async function fetchEodhd(symbol: string, fromUnix: number, toUnix: number, interval: '1m' | '5m'): Promise<Candle[]> {
  // EODHD intraday max 120 days for 1m, 600 days for 5m. Window we use is small (mins to hours).
  const url = `https://eodhd.com/api/intraday/${encodeURIComponent(symbol)}?api_token=${EOD_KEY}&fmt=json&interval=${interval}&from=${fromUnix}&to=${toUnix}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as any[];
  if (!Array.isArray(data)) return [];
  return data
    .filter((c) => c && typeof c.high === 'number' && typeof c.low === 'number')
    .map((c) => ({
      ts: typeof c.timestamp === 'number' ? c.timestamp : new Date(c.datetime + 'Z').getTime() / 1000,
      high: c.high,
      low: c.low,
    }));
}

async function fetchCandles(trade: Trade): Promise<Candle[]> {
  const entryUnix = Math.floor(new Date(trade.entry_timestamp).getTime() / 1000);
  const exitUnix = Math.floor(new Date(trade.exit_timestamp!).getTime() / 1000);
  const durationSec = exitUnix - entryUnix;
  const interval: '1m' | '5m' = durationSec < 1800 ? '1m' : '5m';
  const from = entryUnix - 300;
  const to = exitUnix + 300;

  const isCrypto = trade.asset_class.startsWith('crypto') || /USDT$|USD\.CC$|-USD/.test(trade.symbol);
  if (isCrypto) {
    // Binance is geo-blocked from this env → use EODHD .CC
    const eodSym = cryptoToEodhd(trade.symbol);
    if (eodSym) {
      let c = await fetchEodhd(eodSym, from, to, interval);
      if (c.length === 0 && interval === '5m') c = await fetchEodhd(eodSym, from, to, '1m');
      if (c.length) return c;
    }
    // last-resort Binance attempt (unlikely to work here)
    const bin = normalizeCryptoForBinance(trade.symbol);
    if (bin) {
      const c = await fetchBinance(bin, from, to, interval);
      if (c.length) return c;
    }
    return [];
  }
  // equities → EODHD
  let candles = await fetchEodhd(trade.symbol, from, to, interval);
  if (candles.length === 0 && interval === '5m') {
    // try 1m
    candles = await fetchEodhd(trade.symbol, from, to, '1m');
  }
  return candles;
}

/* ----------------------- Metrics ----------------------- */

type TradeMetrics = {
  trade: Trade;
  mfe_pct: number;
  mae_pct: number;
  mfe_price: number;
  mae_price: number;
  capture_rate: number | null;
  mae_over_R: number | null;
  mfe_over_target: number | null;
  realized_pct: number;
  potential_pnl_usd: number; // pnl if exited at MFE peak
  realized_pnl_usd: number;
  exit_bucket: string;
  portfolio_label: string;
  candles_n: number;
};

function computeMetrics(trade: Trade, candles: Candle[]): TradeMetrics | null {
  if (candles.length === 0) return null;
  const entry = parseFloat(trade.entry_price);
  if (!isFinite(entry) || entry <= 0) return null;
  const isLong = trade.direction === 'long';

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);

  const mfe_price = isLong ? maxHigh : minLow;
  const mae_price = isLong ? minLow : maxHigh;
  const sign = isLong ? 1 : -1;

  const mfe_pct = (sign * (mfe_price - entry)) / entry * 100;
  const mae_pct = (sign * (mae_price - entry)) / entry * 100; // will be ≤ 0 typically

  // realized_pnl_pct in DB is ALREADY in percent units (verified: SAA.LSE
  // entry 138 → exit 139 = +0.724% gross → DB stores 0.6239 after fees).
  const realized_pct_pct = parseFloat(trade.realized_pnl_pct || '0');

  // Capture rate: only for winners (mfe_pct > 0) — fraction of peak gain captured
  let capture_rate: number | null = null;
  if (mfe_pct > 0.01) {
    // No clamp — keep raw ratio so we see >1.0 cases (realized > intraday-high → fill happened mid-candle above sampled high)
    capture_rate = realized_pct_pct / mfe_pct;
  }

  // SL / TP distance
  const sl = trade.stop_loss_price ? parseFloat(trade.stop_loss_price) : null;
  const tp = trade.take_profit_price ? parseFloat(trade.take_profit_price) : null;
  let mae_over_R: number | null = null;
  if (sl && sl > 0) {
    const sl_dist_pct = Math.abs((sign * (sl - entry)) / entry * 100); // distance to SL in %
    if (sl_dist_pct > 0.001) mae_over_R = Math.abs(mae_pct) / sl_dist_pct;
  }
  let mfe_over_target: number | null = null;
  if (tp && tp > 0) {
    const tp_dist_pct = Math.abs((sign * (tp - entry)) / entry * 100);
    if (tp_dist_pct > 0.001) mfe_over_target = mfe_pct / tp_dist_pct;
  }

  // potential pnl USD if exited exactly at MFE peak
  const notional = parseFloat(trade.entry_notional_usd || '0');
  const potential_pnl_usd = notional > 0 ? (mfe_pct / 100) * notional : 0;
  const realized_pnl_usd = parseFloat(trade.realized_pnl_usd || '0');

  return {
    trade,
    mfe_pct,
    mae_pct,
    mfe_price,
    mae_price,
    capture_rate,
    mae_over_R,
    mfe_over_target,
    realized_pct: realized_pct_pct,
    // also derive raw price-only pct for sanity (excludes fees)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    // gross_pct: (sign * (parseFloat(trade.exit_price || '0') - entry)) / entry * 100,
    potential_pnl_usd,
    realized_pnl_usd,
    exit_bucket: categorizeExit(trade.exit_reason),
    portfolio_label: PORTFOLIOS[trade.portfolio_id] || trade.portfolio_id.slice(0, 8),
    candles_n: candles.length,
  };
}

/* ----------------------- Aggregation helpers ----------------------- */

function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function pct(n: number): string {
  return isFinite(n) ? n.toFixed(1) : '—';
}

function fmt(n: number, d = 2): string {
  return isFinite(n) ? n.toFixed(d) : '—';
}

/* ----------------------- Rate limit pool ----------------------- */

async function withConcurrency<T, R>(items: T[], concurrency: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        results[idx] = undefined as any;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/* ----------------------- Main ----------------------- */

async function main() {
  console.log(`\n=== MFE/MAE analysis since ${SINCE} (Sweeney 1996) ===\n`);

  const trades = await fetchTrades();
  console.log(`Fetched ${trades.length} closed trades`);

  // skip trades without exit_timestamp or entry_price
  const valid = trades.filter((t) => t.exit_timestamp && t.entry_price);
  console.log(`Valid (have exit_timestamp + entry_price): ${valid.length}`);

  // throttle to ~15 concurrent fetches (mix of Binance and EODHD)
  let processed = 0;
  let lastLog = Date.now();
  const startedAt = Date.now();

  const metrics: (TradeMetrics | null)[] = await withConcurrency(valid, 12, async (t) => {
    try {
      const candles = await fetchCandles(t);
      const m = computeMetrics(t, candles);
      processed++;
      if (Date.now() - lastLog > 5000) {
        console.log(`  progress: ${processed}/${valid.length} (${Math.round(((Date.now() - startedAt) / 1000))}s)`);
        lastLog = Date.now();
      }
      return m;
    } catch (e) {
      processed++;
      return null;
    }
  });

  const ok = metrics.filter((m): m is TradeMetrics => m !== null);
  const skipped = metrics.length - ok.length;
  console.log(`\nClassified: ${ok.length}  |  Skipped (no candles): ${skipped}\n`);

  /* ------------------ Global ------------------ */
  const cap = ok.map((m) => m.capture_rate).filter((v): v is number => v !== null);
  const maeR = ok.map((m) => m.mae_over_R).filter((v): v is number => v !== null);
  const mfeT = ok.map((m) => m.mfe_over_target).filter((v): v is number => v !== null);
  const totalRealized = sum(ok.map((m) => m.realized_pnl_usd));
  const totalPotential = sum(ok.map((m) => m.potential_pnl_usd));

  console.log('## 1. Global metrics');
  console.log('| Metric | Value |');
  console.log('|---|---|');
  console.log(`| n_total_fetched | ${trades.length} |`);
  console.log(`| n_classified   | ${ok.length} |`);
  console.log(`| n_skipped_no_data | ${skipped} |`);
  console.log(`| Capture Rate median (winners only, n=${cap.length}) | ${pct(median(cap) * 100)}% |`);
  console.log(`| Capture Rate mean   | ${pct(mean(cap) * 100)}% |`);
  console.log(`| MAE/R median (n=${maeR.length}) | ${fmt(median(maeR))} |`);
  console.log(`| MFE/Target median (n=${mfeT.length}) | ${fmt(median(mfeT))} |`);
  console.log(`| Σ realized_pnl_usd | $${fmt(totalRealized)} |`);
  console.log(`| Σ potential_pnl_usd (if exited at MFE peak) | $${fmt(totalPotential)} |`);
  console.log(`| 💸 Money left on table | $${fmt(totalPotential - totalRealized)} |\n`);

  /* ------------------ Per portfolio ------------------ */
  console.log('## 2. Per portfolio');
  console.log('| Portfolio | n | Capture % med | MAE/R med | MFE/T med | Σ realized $ | Σ potential $ | Left on table $ |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const portId of Object.keys(PORTFOLIOS)) {
    const subset = ok.filter((m) => m.trade.portfolio_id === portId);
    if (subset.length === 0) {
      console.log(`| ${PORTFOLIOS[portId]} | 0 | — | — | — | — | — | — |`);
      continue;
    }
    const cs = subset.map((m) => m.capture_rate).filter((v): v is number => v !== null);
    const mrs = subset.map((m) => m.mae_over_R).filter((v): v is number => v !== null);
    const mts = subset.map((m) => m.mfe_over_target).filter((v): v is number => v !== null);
    const r = sum(subset.map((m) => m.realized_pnl_usd));
    const p = sum(subset.map((m) => m.potential_pnl_usd));
    console.log(
      `| ${PORTFOLIOS[portId]} | ${subset.length} | ${pct(median(cs) * 100)}% | ${fmt(median(mrs))} | ${fmt(median(mts))} | ${fmt(r)} | ${fmt(p)} | ${fmt(p - r)} |`,
    );
  }
  console.log();

  /* ------------------ Per exit bucket ------------------ */
  console.log('## 3. Per exit_reason bucket');
  console.log('| Bucket | n | Capture % med | MAE/R med | MFE/T med | Σ realized $ | Σ potential $ | Left on table $ |');
  console.log('|---|---|---|---|---|---|---|---|');
  const buckets = Array.from(new Set(ok.map((m) => m.exit_bucket)));
  for (const b of buckets.sort()) {
    const subset = ok.filter((m) => m.exit_bucket === b);
    const cs = subset.map((m) => m.capture_rate).filter((v): v is number => v !== null);
    const mrs = subset.map((m) => m.mae_over_R).filter((v): v is number => v !== null);
    const mts = subset.map((m) => m.mfe_over_target).filter((v): v is number => v !== null);
    const r = sum(subset.map((m) => m.realized_pnl_usd));
    const p = sum(subset.map((m) => m.potential_pnl_usd));
    console.log(
      `| ${b} | ${subset.length} | ${pct(median(cs) * 100)}% | ${fmt(median(mrs))} | ${fmt(median(mts))} | ${fmt(r)} | ${fmt(p)} | ${fmt(p - r)} |`,
    );
  }
  console.log();

  /* ------------------ Skip distribution ------------------ */
  const skippedByClass = new Map<string, number>();
  for (let i = 0; i < metrics.length; i++) {
    if (metrics[i] === null) {
      const t = valid[i];
      const k = t.asset_class || 'unknown';
      skippedByClass.set(k, (skippedByClass.get(k) || 0) + 1);
    }
  }
  console.log('## Skipped by asset_class');
  for (const [k, v] of skippedByClass) console.log(`  ${k}: ${v}`);
  console.log();

  /* ------------------ Deep dive: SL hits with positive MFE ------------------ */
  const slHits = ok.filter((m) => m.exit_bucket === 'SL_HIT');
  const slHadProfit = slHits.filter((m) => m.mfe_pct > 0.5);
  const slPotential = sum(slHadProfit.map((m) => m.potential_pnl_usd));
  console.log('## 4a. SL hits that had MFE > +0.5% BEFORE stop');
  console.log(`  ${slHadProfit.length}/${slHits.length} SL trades had a profit window`);
  console.log(`  Σ potential at MFE peak: $${fmt(slPotential)} | Σ realized: $${fmt(sum(slHadProfit.map((m) => m.realized_pnl_usd)))}`);
  console.log(`  → Trailing stop opportunity: ~$${fmt(slPotential - sum(slHadProfit.map((m) => m.realized_pnl_usd)))} recoverable\n`);

  /* ------------------ Deep dive: TP hits that overshot ------------------ */
  const tpHits = ok.filter((m) => m.exit_bucket === 'TP_HIT');
  const tpOvershoot = tpHits.filter((m) => (m.mfe_over_target ?? 0) > 1.2);
  console.log('## 4b. TP hits with MFE/Target > 1.2 (left ≥20% on table)');
  console.log(`  ${tpOvershoot.length}/${tpHits.length} TP trades overshot the target`);
  if (tpOvershoot.length) {
    const left = sum(tpOvershoot.map((m) => m.potential_pnl_usd - m.realized_pnl_usd));
    console.log(`  Median MFE/Target on overshoot: ${fmt(median(tpOvershoot.map((m) => m.mfe_over_target!)))}`);
    console.log(`  Σ extra $ if exited at MFE: $${fmt(left)}\n`);
  }

  /* ------------------ Deep dive: FADE / early_exit ------------------ */
  const fadeExits = ok.filter((m) => m.exit_bucket === 'early_exit_FADE');
  console.log('## 4c. early_exit_FADE Gemini');
  if (fadeExits.length) {
    const winners = fadeExits.filter((m) => m.realized_pct > 0);
    const losers = fadeExits.filter((m) => m.realized_pct <= 0);
    console.log(`  n=${fadeExits.length}  |  realized winners ${winners.length} / losers ${losers.length}`);
    console.log(`  Median Capture Rate: ${pct(median(fadeExits.map((m) => m.capture_rate ?? 0)) * 100)}%`);
    const cut = sum(fadeExits.map((m) => m.potential_pnl_usd - m.realized_pnl_usd));
    console.log(`  Σ MFE peak - realized: $${fmt(cut)} (potential cut by Gemini)`);
  } else {
    console.log('  n=0 (no FADE exits in sample)');
  }
  console.log();

  /* ------------------ Deep dive: closed_invalidated / closed_user ------------------ */
  for (const bucket of ['closed_invalidated', 'closed_user', 'rotation', 'force_close']) {
    const subset = ok.filter((m) => m.exit_bucket === bucket);
    if (subset.length === 0) continue;
    const r = sum(subset.map((m) => m.realized_pnl_usd));
    const p = sum(subset.map((m) => m.potential_pnl_usd));
    const winnersCount = subset.filter((m) => m.mfe_pct > 0.5).length;
    console.log(
      `## 4d. ${bucket}: n=${subset.length}, ${winnersCount} had MFE>+0.5%, Σ realized=${fmt(r)}, Σ potential=${fmt(p)}, left=${fmt(p - r)}`,
    );
  }
  console.log();

  /* ------------------ Persist lessons ------------------ */
  console.log('## 5. Persisting lessons → scanner_lessons');

  const lessons: any[] = [];

  // Lesson 1 — global capture rate
  const capMed = median(cap);
  lessons.push({
    derived_from_date: new Date().toISOString().slice(0, 10),
    lesson_kind: 'trade_metrics',
    scope: 'global',
    macro_condition: null,
    confidence: 0.85,
    sample_size: cap.length,
    lesson_text: `Capture Rate global médian = ${pct(capMed * 100)}% (n=${cap.length} winners, ${ok.length} trades classifiés). Benchmark Sweeney/retail moyen 35-55%, healthy 55-70%. SmartVest est ${capMed * 100 < 35 ? 'EN DESSOUS du seuil retail — exit trop tôt ou trop tard' : capMed * 100 < 55 ? 'dans la zone retail moyenne' : capMed * 100 < 70 ? 'dans la zone healthy' : 'au-dessus du benchmark healthy'}. ${capMed * 100 < 35 ? 'Action: relâcher gates de sortie (FADE Gemini, early-exit), envisager trailing TP plus généreux.' : 'Action: maintenir la discipline actuelle.'}`,
    proposed_config_change: null,
    is_active: true,
    payload: {
      capture_rate_median: capMed,
      capture_rate_mean: mean(cap),
      total_realized_usd: totalRealized,
      total_potential_usd: totalPotential,
      money_left_on_table_usd: totalPotential - totalRealized,
    },
  });

  // Lesson 2 — SL trailing opportunity
  if (slHadProfit.length >= 5) {
    const recoverable = slPotential - sum(slHadProfit.map((m) => m.realized_pnl_usd));
    lessons.push({
      derived_from_date: new Date().toISOString().slice(0, 10),
      lesson_kind: 'trade_metrics',
      scope: 'global',
      macro_condition: null,
      confidence: 0.8,
      sample_size: slHits.length,
      lesson_text: `SL_HIT analysis: ${slHadProfit.length}/${slHits.length} (${pct((slHadProfit.length / slHits.length) * 100)}%) des trades stoppés avaient touché un MFE > +0.5% AVANT le SL. Σ recoverable si trailing breakeven activé: $${fmt(recoverable)}. Recommandation: activer GAINERS_TRAILING_STOP_BREAKEVEN_ENABLED sur classes asia_equity/eu_equity si pas déjà.`,
      proposed_config_change: { secret: 'GAINERS_TRAILING_STOP_BREAKEVEN_ENABLED', value: 'true' },
      is_active: true,
      payload: { sl_with_profit_window: slHadProfit.length, sl_total: slHits.length, recoverable_usd: recoverable },
    });
  }

  // Lesson 3 — TP overshoot
  if (tpOvershoot.length >= 3) {
    const left = sum(tpOvershoot.map((m) => m.potential_pnl_usd - m.realized_pnl_usd));
    const medOver = median(tpOvershoot.map((m) => m.mfe_over_target!));
    lessons.push({
      derived_from_date: new Date().toISOString().slice(0, 10),
      lesson_kind: 'trade_metrics',
      scope: 'global',
      macro_condition: null,
      confidence: 0.75,
      sample_size: tpHits.length,
      lesson_text: `TP_HIT overshoot: ${tpOvershoot.length}/${tpHits.length} TPs ont continué au-delà du target (MFE/Target médian sur overshoot=${fmt(medOver)}, soit +${pct((medOver - 1) * 100)}% au-delà). $${fmt(left)} laissés au-delà du TP. Recommandation: activer GAINERS_TRAILING_TP_ENABLED ou élargir TP de 20-30% sur ces classes.`,
      proposed_config_change: { secret: 'GAINERS_TRAILING_TP_ENABLED', value: 'true' },
      is_active: true,
      payload: { tp_overshoots: tpOvershoot.length, tp_total: tpHits.length, left_on_table_usd: left, median_overshoot_ratio: medOver },
    });
  }

  // Lesson 4 — MAE/R discipline
  const maeRMed = median(maeR);
  if (maeR.length >= 20) {
    lessons.push({
      derived_from_date: new Date().toISOString().slice(0, 10),
      lesson_kind: 'trade_metrics',
      scope: 'global',
      macro_condition: null,
      confidence: 0.8,
      sample_size: maeR.length,
      lesson_text: `MAE/R discipline: médian=${fmt(maeRMed)} (n=${maeR.length}). Benchmark healthy 0.6-0.85. ${maeRMed >= 1.0 ? 'CRITIQUE: trades touchent le SL trop souvent (>1.0) — pas de marge d\'erreur, repenser SL placement ou entry timing.' : maeRMed >= 0.85 ? 'Trades stressent leur SL — proche du seuil. Vérifier sizing/SL.' : maeRMed >= 0.6 ? 'Sain — bonne marge entre MAE et SL.' : 'Très conservatif — SL peut-être trop large vs MAE typique, opportunité de tighter pour augmenter R/R.'}`,
      proposed_config_change: null,
      is_active: true,
      payload: { mae_over_R_median: maeRMed, mae_over_R_mean: mean(maeR), sample: maeR.length },
    });
  }

  // Lesson 5 — FADE Gemini efficiency
  if (fadeExits.length >= 5) {
    const fadeCut = sum(fadeExits.map((m) => m.potential_pnl_usd - m.realized_pnl_usd));
    const fadeLossSaved = fadeExits.filter((m) => m.mfe_pct < 0.5).length;
    lessons.push({
      derived_from_date: new Date().toISOString().slice(0, 10),
      lesson_kind: 'trade_metrics',
      scope: 'global',
      macro_condition: null,
      confidence: 0.7,
      sample_size: fadeExits.length,
      lesson_text: `early_exit_FADE (Gemini Risk Manager): n=${fadeExits.length}. ${fadeLossSaved} trades n'avaient jamais dépassé +0.5% (loss prévenue justifiée). Mais Σ ${fmt(fadeCut)} sacrifiés vs MFE peak. Capture Rate médian FADE=${pct(median(fadeExits.map((m) => m.capture_rate ?? 0)) * 100)}%. Si capture<30%, Gemini coupe TROP tôt sur les gagnants.`,
      proposed_config_change: null,
      is_active: true,
      payload: { fade_count: fadeExits.length, fade_loss_prevented: fadeLossSaved, sacrificed_usd: fadeCut },
    });
  }

  // Lesson 6 — per asset_class capture rate (asia_equity is biggest sample)
  const perClass: Record<string, TradeMetrics[]> = {};
  for (const m of ok) {
    const k = m.trade.asset_class;
    if (!perClass[k]) perClass[k] = [];
    perClass[k].push(m);
  }
  for (const [cls, arr] of Object.entries(perClass)) {
    if (arr.length < 30) continue;
    const cs = arr.map((m) => m.capture_rate).filter((v): v is number => v !== null);
    const rs = sum(arr.map((m) => m.realized_pnl_usd));
    const ps = sum(arr.map((m) => m.potential_pnl_usd));
    lessons.push({
      derived_from_date: new Date().toISOString().slice(0, 10),
      lesson_kind: 'trade_metrics',
      scope: cls,
      macro_condition: null,
      confidence: 0.78,
      sample_size: arr.length,
      lesson_text: `Class ${cls} (n=${arr.length}): Capture Rate médian=${pct(median(cs) * 100)}%, MAE/R médian=${fmt(median(arr.map((m) => m.mae_over_R).filter((v): v is number => v !== null)))}. Σ realized=$${fmt(rs)}, Σ potential=$${fmt(ps)}, left=$${fmt(ps - rs)}. ${(ps - rs) > Math.abs(rs) * 2 ? 'Money left on table > 2× realized — exit logic sous-performe nettement sur cette classe.' : 'Exit logic raisonnable sur cette classe.'}`,
      proposed_config_change: null,
      is_active: true,
      payload: { class: cls, capture_median: median(cs), realized_usd: rs, potential_usd: ps },
    });
  }

  try {
    const inserted = await supaPost('scanner_lessons', lessons);
    console.log(`  ✅ Inserted ${inserted.length} lessons`);
    for (const l of inserted) {
      console.log(`    - ${l.id} (${l.scope}/${l.sample_size}): ${l.lesson_text.slice(0, 80)}…`);
    }
  } catch (e: any) {
    console.error(`  ❌ Insert failed: ${e.message}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
