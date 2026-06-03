/**
 * Recalc indicateurs techniques sur paper_trades / lisa_positions historiques.
 * Pour chaque trade fermé : fetch EODHD intraday candles 5m, compute indicateurs
 * @entry et @exit, bucket par outcome (winner/loser), sortir distribution.
 *
 * Sortie : out/indicator-calibration-YYYYMMDD.json
 *
 * Usage :
 *   EODHD_API_KEY=xxx npx tsx scripts/recalc-indicators-historical.ts
 *   EODHD_API_KEY=xxx npx tsx scripts/recalc-indicators-historical.ts --limit=20
 *
 * Indicateurs computés (Phase 1, top 5 prioritaires) :
 *   RSI(14), MACD(12,26,9), Bollinger(20,2), ATR(14), ADX(14)
 * Indicateurs supplémentaires en Phase 2 (PR séparée si validé) :
 *   CCI(20), StochRSI(14,3,3), Supertrend(10,3), VWAP, EMA9/21, OBV
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY!;
const EODHD_KEY = env.EODHD_API_KEY ?? process.env.EODHD_API_KEY;

if (!EODHD_KEY) {
  console.error('❌ EODHD_API_KEY absent (ni en .env, ni en env var). Abort.');
  console.error('   Run sur Fly machine OU ajoute la clé en .env local.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length) ?? '120');

// ============================================================
// Indicateurs purs (Phase 1 — top 5 prioritaires)
// ============================================================

interface Candle { ts: number; open: number; high: number; low: number; close: number; volume: number; }

function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period; // SMA seed
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(closes: number[]): { macd: number; signal: number; hist: number } | null {
  if (closes.length < 35) return null;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (!ema12.length || !ema26.length) return null;
  const offset = ema12.length - ema26.length;
  const macdLine: number[] = [];
  for (let i = 0; i < ema26.length; i++) macdLine.push(ema12[i + offset] - ema26[i]);
  const signal = ema(macdLine, 9);
  if (!signal.length) return null;
  const macdVal = macdLine[macdLine.length - 1];
  const sigVal = signal[signal.length - 1];
  return { macd: macdVal, signal: sigVal, hist: macdVal - sigVal };
}

function bollinger(closes: number[], period = 20, mult = 2): { upper: number; mid: number; lower: number; pctB: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const last = closes[closes.length - 1];
  const pctB = (upper - lower) > 0 ? (last - lower) / (upper - lower) : 0.5;
  return { upper, mid, lower, pctB };
}

function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    trs.push(tr);
  }
  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atrVal = (atrVal * (period - 1) + trs[i]) / period;
  return atrVal;
}

function adx(candles: Candle[], period = 14): number | null {
  if (candles.length < 2 * period + 1) return null;
  const trs: number[] = [], plusDMs: number[] = [], minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high;
    const dn = p.low - c.low;
    plusDMs.push(up > dn && up > 0 ? up : 0);
    minusDMs.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  // Wilder smoothing
  const smooth = (arr: number[], n: number): number[] => {
    const out: number[] = [];
    let s = arr.slice(0, n).reduce((a, b) => a + b, 0);
    out.push(s);
    for (let i = n; i < arr.length; i++) {
      s = s - s / n + arr[i];
      out.push(s);
    }
    return out;
  };
  const sTR = smooth(trs, period);
  const sPDM = smooth(plusDMs, period);
  const sMDM = smooth(minusDMs, period);
  const dx: number[] = [];
  for (let i = 0; i < sTR.length; i++) {
    const pDI = 100 * (sPDM[i] / sTR[i]);
    const mDI = 100 * (sMDM[i] / sTR[i]);
    dx.push(100 * Math.abs(pDI - mDI) / (pDI + mDI || 1));
  }
  if (dx.length < period) return null;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adxVal = (adxVal * (period - 1) + dx[i]) / period;
  return adxVal;
}

// ============================================================
// EODHD fetcher
// ============================================================

interface EodhdIntradayRow { timestamp: number; gmtoffset?: number; datetime: string; open: number; high: number; low: number; close: number; volume: number; }

async function fetchCandles5m(symbol: string, fromTs: number, toTs: number): Promise<Candle[]> {
  const url = `https://eodhd.com/api/intraday/${encodeURIComponent(symbol)}?api_token=${EODHD_KEY}&interval=5m&from=${fromTs}&to=${toTs}&fmt=json`;
  const r = await fetch(url);
  if (!r.ok) {
    console.error(`  EODHD ${symbol} HTTP ${r.status}`);
    return [];
  }
  const arr = await r.json() as EodhdIntradayRow[];
  return (arr ?? []).map((x) => ({
    ts: x.timestamp * 1000,
    open: Number(x.open),
    high: Number(x.high),
    low: Number(x.low),
    close: Number(x.close),
    volume: Number(x.volume ?? 0),
  })).filter((c) => Number.isFinite(c.close) && c.close > 0);
}

// ============================================================
// Main
// ============================================================

interface IndicatorSnapshot {
  rsi14: number | null;
  macd: number | null;
  macd_signal: number | null;
  macd_hist: number | null;
  bb_upper: number | null;
  bb_mid: number | null;
  bb_lower: number | null;
  bb_pct_b: number | null;
  atr14: number | null;
  atr14_pct: number | null;
  adx14: number | null;
}

function snapshotAt(candles: Candle[], targetTs: number): IndicatorSnapshot | null {
  // Find last candle with ts <= targetTs
  let idx = -1;
  for (let i = candles.length - 1; i >= 0; i--) if (candles[i].ts <= targetTs) { idx = i; break; }
  if (idx < 30) return null; // not enough history
  const slice = candles.slice(0, idx + 1);
  const closes = slice.map((c) => c.close);
  const r = rsi(closes);
  const m = macd(closes);
  const b = bollinger(closes);
  const a = atr(slice);
  const ad = adx(slice);
  const lastClose = closes[closes.length - 1];
  return {
    rsi14: r,
    macd: m?.macd ?? null,
    macd_signal: m?.signal ?? null,
    macd_hist: m?.hist ?? null,
    bb_upper: b?.upper ?? null,
    bb_mid: b?.mid ?? null,
    bb_lower: b?.lower ?? null,
    bb_pct_b: b?.pctB ?? null,
    atr14: a,
    atr14_pct: a !== null && lastClose > 0 ? (a / lastClose) * 100 : null,
    adx14: ad,
  };
}

interface TradeRecord {
  id: string;
  symbol: string;
  asset_class: string | null;
  entry_price: number;
  exit_price: number | null;
  entry_ts: number;
  exit_ts: number | null;
  exit_reason: string | null;
  realized_pnl_pct: number | null;
  outcome: 'WINNER' | 'LOSER' | 'NEUTRAL';
}

function classifyOutcome(pnlPct: number | null, exitReason: string | null): 'WINNER' | 'LOSER' | 'NEUTRAL' {
  if (pnlPct === null) return 'NEUTRAL';
  if (pnlPct >= 0.5) return 'WINNER';
  if (pnlPct <= -0.5) return 'LOSER';
  return 'NEUTRAL';
}

function quantile(arr: number[], q: number): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

(async () => {
  console.log(`\n========== RECALC INDICATORS HISTORIQUE — limit ${LIMIT} trades ==========\n`);

  // 1. Fetch trades
  const { data: trades }: any = await sb.from('lisa_positions')
    .select('id, symbol, asset_class, entry_price, exit_price, entry_timestamp, exit_timestamp, exit_reason, realized_pnl_pct')
    .neq('status', 'open')
    .order('entry_timestamp', { ascending: false })
    .limit(LIMIT);
  const records: TradeRecord[] = (trades ?? []).map((t: any) => ({
    id: t.id,
    symbol: t.symbol,
    asset_class: t.asset_class,
    entry_price: Number(t.entry_price),
    exit_price: t.exit_price !== null ? Number(t.exit_price) : null,
    entry_ts: new Date(t.entry_timestamp).getTime(),
    exit_ts: t.exit_timestamp ? new Date(t.exit_timestamp).getTime() : null,
    exit_reason: t.exit_reason,
    realized_pnl_pct: t.realized_pnl_pct !== null ? Number(t.realized_pnl_pct) : null,
    outcome: classifyOutcome(t.realized_pnl_pct, t.exit_reason),
  }));
  console.log(`Trades fetched: ${records.length}`);
  const distOutcome: Record<string, number> = {};
  for (const r of records) distOutcome[r.outcome] = (distOutcome[r.outcome] ?? 0) + 1;
  console.log('Outcome distribution:', distOutcome);

  // 2. Group by symbol — fetch candles 1× par symbol couvrant min(entry)-1h → max(exit)+1h
  const bySymbol: Record<string, TradeRecord[]> = {};
  for (const r of records) (bySymbol[r.symbol] ??= []).push(r);
  console.log(`Unique symbols: ${Object.keys(bySymbol).length}`);

  // 3. Process each symbol
  type IndStat = { value: number; outcome: string; symbol: string; tradeId: string; at: 'entry' | 'exit' };
  const bucketByIndicator: Record<string, IndStat[]> = {};
  let processedTrades = 0, skippedNoCandles = 0, skippedNotEnoughHistory = 0;

  for (const [symbol, list] of Object.entries(bySymbol)) {
    const minEntry = Math.min(...list.map((r) => r.entry_ts));
    const maxExit = Math.max(...list.map((r) => r.exit_ts ?? r.entry_ts));
    // Window : 1 jour avant min entry (pour avoir 30+ candles 5m d'historique) → 1h après max exit
    const fromTs = Math.floor((minEntry - 86400_000) / 1000);
    const toTs = Math.floor((maxExit + 3600_000) / 1000);
    const candles = await fetchCandles5m(symbol, fromTs, toTs);
    if (!candles.length) {
      skippedNoCandles += list.length;
      continue;
    }
    for (const r of list) {
      const snap = snapshotAt(candles, r.entry_ts);
      if (!snap || snap.rsi14 === null) { skippedNotEnoughHistory++; continue; }
      // Bucket each indicator value
      for (const [k, v] of Object.entries(snap)) {
        if (v === null || !Number.isFinite(v)) continue;
        (bucketByIndicator[k] ??= []).push({ value: v, outcome: r.outcome, symbol, tradeId: r.id, at: 'entry' });
      }
      processedTrades++;
    }
    await new Promise((res) => setTimeout(res, 100)); // gentle rate-limit
  }

  console.log(`\nProcessed trades: ${processedTrades}`);
  console.log(`Skipped (no candles): ${skippedNoCandles}`);
  console.log(`Skipped (not enough history): ${skippedNotEnoughHistory}`);

  // 4. Compute distribution per indicator per outcome
  const output: any = {
    generated_at: new Date().toISOString(),
    trades_processed: processedTrades,
    outcome_distribution: distOutcome,
    indicators: {},
  };
  for (const [ind, samples] of Object.entries(bucketByIndicator)) {
    const winners = samples.filter((s) => s.outcome === 'WINNER').map((s) => s.value);
    const losers = samples.filter((s) => s.outcome === 'LOSER').map((s) => s.value);
    const all = samples.map((s) => s.value);
    output.indicators[ind] = {
      n: samples.length,
      n_winners: winners.length,
      n_losers: losers.length,
      all: { p25: quantile(all, 0.25), p50: quantile(all, 0.5), p75: quantile(all, 0.75) },
      winners: { p25: quantile(winners, 0.25), p50: quantile(winners, 0.5), p75: quantile(winners, 0.75) },
      losers: { p25: quantile(losers, 0.25), p50: quantile(losers, 0.5), p75: quantile(losers, 0.75) },
    };
  }

  // 5. Write to disk
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outPath = path.join('out', `indicator-calibration-${dateStr}.json`);
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Output: ${outPath}\n`);

  // 6. Print summary table
  console.log('━━━ EMPIRICAL DISTRIBUTION SUMMARY ━━━');
  console.log('indicator    n    p50(winners)  p50(losers)  separation');
  for (const ind of Object.keys(output.indicators)) {
    const o = output.indicators[ind];
    const wP50 = o.winners.p50?.toFixed(2) ?? '-';
    const lP50 = o.losers.p50?.toFixed(2) ?? '-';
    const sep = (o.winners.p50 !== null && o.losers.p50 !== null)
      ? Math.abs(o.winners.p50 - o.losers.p50).toFixed(2)
      : '-';
    console.log(`${ind.padEnd(13)} ${String(o.n).padStart(3)}  ${String(wP50).padStart(10)}   ${String(lP50).padStart(10)}   ${sep}`);
  }
})();
