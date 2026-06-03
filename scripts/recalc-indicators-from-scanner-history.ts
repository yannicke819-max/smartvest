/**
 * Phase B — calibration empirique étendue via top_gainers_log historique (324k rows sur 1 mois).
 *
 * Pour chaque candidat top-gainer historique :
 *   1. Fetch EODHD candles 5m autour de captured_at
 *   2. Compute indicateurs @ captured_at (= si on était entré à ce moment)
 *   3. Simuler outcome à 4 horizons : T+15min, T+30min, T+60min, T+4h
 *      WIN = price after horizon ≥ +2% vs captured (TP simulé)
 *      LOSE = price after horizon ≤ -1.5% (SL simulé)
 *      NEUTRAL sinon
 *   4. Bucket + distribution per indicator per outcome
 *
 * Sample massif (~5k candidats), confidence ×50 vs Phase A.
 *
 * Usage : EODHD_API_KEY=xxx npx tsx scripts/recalc-indicators-from-scanner-history.ts --sample=5000 --horizon=60
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

if (!EODHD_KEY) { console.error('❌ EODHD_API_KEY absent'); process.exit(1); }

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const SAMPLE = Number(process.argv.find((a) => a.startsWith('--sample='))?.slice('--sample='.length) ?? '2000');
const HORIZON_MIN = Number(process.argv.find((a) => a.startsWith('--horizon='))?.slice('--horizon='.length) ?? '60');
const TP_PCT = Number(process.argv.find((a) => a.startsWith('--tp='))?.slice('--tp='.length) ?? '2.0');
const SL_PCT = Number(process.argv.find((a) => a.startsWith('--sl='))?.slice('--sl='.length) ?? '1.5');

console.log(`Settings: sample=${SAMPLE} horizon=${HORIZON_MIN}min TP=+${TP_PCT}% SL=-${SL_PCT}%`);

// ============================================================
// Indicateurs (copie depuis recalc-indicators-historical.ts)
// ============================================================
interface Candle { ts: number; open: number; high: number; low: number; close: number; volume: number; }

function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gains += d; else losses -= d; }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function macd(closes: number[]): { macd: number; signal: number; hist: number } | null {
  if (closes.length < 35) return null;
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  if (!e12.length || !e26.length) return null;
  const offset = e12.length - e26.length;
  const line: number[] = [];
  for (let i = 0; i < e26.length; i++) line.push(e12[i + offset] - e26[i]);
  const sig = ema(line, 9);
  if (!sig.length) return null;
  const m = line[line.length - 1], s = sig[sig.length - 1];
  return { macd: m, signal: s, hist: m - s };
}

function bollinger(closes: number[], period = 20, mult = 2): { upper: number; mid: number; lower: number; pctB: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  const upper = mid + mult * sd, lower = mid - mult * sd;
  const last = closes[closes.length - 1];
  const pctB = (upper - lower) > 0 ? (last - lower) / (upper - lower) : 0.5;
  return { upper, mid, lower, pctB };
}

function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let v = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) v = (v * (period - 1) + trs[i]) / period;
  return v;
}

function adx(candles: Candle[], period = 14): number | null {
  if (candles.length < 2 * period + 1) return null;
  const trs: number[] = [], pDM: number[] = [], mDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high, dn = p.low - c.low;
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const smooth = (arr: number[], n: number): number[] => {
    const out: number[] = [];
    let s = arr.slice(0, n).reduce((a, b) => a + b, 0);
    out.push(s);
    for (let i = n; i < arr.length; i++) { s = s - s / n + arr[i]; out.push(s); }
    return out;
  };
  const sT = smooth(trs, period), sP = smooth(pDM, period), sM = smooth(mDM, period);
  const dx: number[] = [];
  for (let i = 0; i < sT.length; i++) {
    const pDI = 100 * (sP[i] / sT[i]), mDI = 100 * (sM[i] / sT[i]);
    dx.push(100 * Math.abs(pDI - mDI) / (pDI + mDI || 1));
  }
  if (dx.length < period) return null;
  let v = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) v = (v * (period - 1) + dx[i]) / period;
  return v;
}

interface Snap { rsi14: number | null; macd: number | null; macd_signal: number | null; macd_hist: number | null; bb_upper: number | null; bb_mid: number | null; bb_lower: number | null; bb_pct_b: number | null; atr14: number | null; atr14_pct: number | null; adx14: number | null; }

function snapshotAt(candles: Candle[], targetTs: number): Snap | null {
  let idx = -1;
  for (let i = candles.length - 1; i >= 0; i--) if (candles[i].ts <= targetTs) { idx = i; break; }
  if (idx < 30) return null;
  const slice = candles.slice(0, idx + 1);
  const closes = slice.map((c) => c.close);
  const r = rsi(closes), m = macd(closes), b = bollinger(closes), a = atr(slice), ad = adx(slice);
  const last = closes[closes.length - 1];
  return {
    rsi14: r, macd: m?.macd ?? null, macd_signal: m?.signal ?? null, macd_hist: m?.hist ?? null,
    bb_upper: b?.upper ?? null, bb_mid: b?.mid ?? null, bb_lower: b?.lower ?? null, bb_pct_b: b?.pctB ?? null,
    atr14: a, atr14_pct: a !== null && last > 0 ? (a / last) * 100 : null, adx14: ad,
  };
}

function quantile(arr: number[], q: number): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  if (lo === hi) return s[lo];
  return s[lo] + (p - lo) * (s[hi] - s[lo]);
}

// ============================================================
// EODHD fetcher (cache mémoire 1 fetch/symbol/day window)
// ============================================================
interface EodhdRow { timestamp: number; open: number; high: number; low: number; close: number; volume: number; }

const candleCache = new Map<string, Candle[]>();

async function fetchCandles5m(symbol: string, fromTs: number, toTs: number): Promise<Candle[]> {
  const key = `${symbol}::${Math.floor(fromTs / 86400)}::${Math.floor(toTs / 86400)}`;
  const hit = candleCache.get(key); if (hit) return hit;
  const url = `https://eodhd.com/api/intraday/${encodeURIComponent(symbol)}?api_token=${EODHD_KEY}&interval=5m&from=${fromTs}&to=${toTs}&fmt=json`;
  try {
    const r = await fetch(url);
    if (!r.ok) { candleCache.set(key, []); return []; }
    const arr = await r.json() as EodhdRow[];
    const candles = (arr ?? []).map((x) => ({
      ts: x.timestamp * 1000, open: Number(x.open), high: Number(x.high),
      low: Number(x.low), close: Number(x.close), volume: Number(x.volume ?? 0),
    })).filter((c) => Number.isFinite(c.close) && c.close > 0);
    candleCache.set(key, candles);
    return candles;
  } catch { return []; }
}

// ============================================================
// Outcome simulator
// ============================================================
function simulateOutcome(candles: Candle[], entryTs: number, entryPrice: number, horizonMin: number, tpPct: number, slPct: number): 'WIN' | 'LOSE' | 'NEUTRAL' | 'NO_DATA' {
  const horizonEnd = entryTs + horizonMin * 60_000;
  const post = candles.filter((c) => c.ts > entryTs && c.ts <= horizonEnd);
  if (post.length === 0) return 'NO_DATA';
  const tpPrice = entryPrice * (1 + tpPct / 100);
  const slPrice = entryPrice * (1 - slPct / 100);
  // Simule order of touch (high before low ou inverse) — on suppose worst case loser pour conservatisme
  for (const c of post) {
    if (c.low <= slPrice) return 'LOSE';
    if (c.high >= tpPrice) return 'WIN';
  }
  // No touch — outcome final = close at horizon vs entry
  const finalClose = post[post.length - 1].close;
  if (finalClose >= entryPrice * 1.005) return 'WIN'; // small win > 0.5%
  if (finalClose <= entryPrice * 0.995) return 'LOSE'; // small loss < -0.5%
  return 'NEUTRAL';
}

// ============================================================
// Main
// ============================================================
(async () => {
  console.log(`\n========== PHASE B — top_gainers_log calibration ==========\n`);

  // 1. Sample top_gainers_log strat random : on prend des candidats variés temporellement + par marché
  // Stratégie : OFFSET random sur la table en limit chunks
  // Plus simple : prendre TOUS les "passed"/"opened" decisions des 4 dernières semaines, sampled
  const since = new Date(Date.now() - 28 * 86400_000).toISOString();
  // Pagination pour récupérer big sample
  const candidates: any[] = [];
  let pageFrom = 0, pageSize = 1000;
  while (candidates.length < SAMPLE) {
    const { data, error } = await sb.from('top_gainers_log')
      .select('symbol, captured_at, close_price, high_price, change_pct, market, decision')
      .gte('captured_at', since)
      .in('decision', ['passed', 'opened'])
      .order('captured_at', { ascending: true })
      .range(pageFrom, pageFrom + pageSize - 1);
    if (error || !data || data.length === 0) break;
    candidates.push(...data);
    if (data.length < pageSize) break;
    pageFrom += pageSize;
  }
  console.log(`Candidates fetched: ${candidates.length}`);
  // Si trop, sample random
  if (candidates.length > SAMPLE) {
    // Fisher-Yates partial shuffle
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    candidates.length = SAMPLE;
  }

  const mktStats: any = {};
  for (const c of candidates) mktStats[c.market ?? '-'] = (mktStats[c.market ?? '-'] ?? 0) + 1;
  console.log('Market distribution:', mktStats);

  // 2. Group by symbol pour cacher les fetches
  const bySymbol: Record<string, any[]> = {};
  for (const c of candidates) (bySymbol[c.symbol] ??= []).push(c);
  console.log(`Unique symbols: ${Object.keys(bySymbol).length}`);

  // 3. Process
  type IndStat = { value: number; outcome: string; symbol: string };
  const bucket: Record<string, IndStat[]> = {};
  const outcomeStats: any = { WIN: 0, LOSE: 0, NEUTRAL: 0, NO_DATA: 0 };
  let processed = 0, skipNoCandles = 0, skipNoHistory = 0, fetchErrors = 0;

  const t0 = Date.now();
  for (const [symbol, list] of Object.entries(bySymbol)) {
    // Window for this symbol : (min captured - 1 day) → (max captured + horizon + 1h)
    const tsList = list.map((c) => new Date(c.captured_at).getTime());
    const fromTs = Math.floor((Math.min(...tsList) - 86400_000) / 1000);
    const toTs = Math.floor((Math.max(...tsList) + (HORIZON_MIN + 60) * 60_000) / 1000);
    const candles = await fetchCandles5m(symbol, fromTs, toTs);
    if (!candles.length) { skipNoCandles += list.length; fetchErrors++; continue; }

    for (const cand of list) {
      const ts = new Date(cand.captured_at).getTime();
      const snap = snapshotAt(candles, ts);
      if (!snap || snap.rsi14 === null) { skipNoHistory++; continue; }
      const entryPrice = Number(cand.close_price);
      const outcome = simulateOutcome(candles, ts, entryPrice, HORIZON_MIN, TP_PCT, SL_PCT);
      outcomeStats[outcome] = (outcomeStats[outcome] ?? 0) + 1;
      if (outcome === 'NO_DATA') continue;
      for (const [k, v] of Object.entries(snap)) {
        if (v === null || !Number.isFinite(v)) continue;
        (bucket[k] ??= []).push({ value: v, outcome, symbol });
      }
      processed++;
    }
    // Light rate limit
    await new Promise((res) => setTimeout(res, 50));
    if (processed % 200 === 0 && processed > 0) {
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`  ...${processed} processed in ${elapsed.toFixed(0)}s`);
    }
  }

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\nProcessed: ${processed} in ${elapsed.toFixed(0)}s`);
  console.log(`Skipped no candles: ${skipNoCandles} (${fetchErrors} symbols fail)`);
  console.log(`Skipped no history: ${skipNoHistory}`);
  console.log(`Outcome distribution:`, outcomeStats);

  // 4. Distribution per indicator
  const output: any = {
    generated_at: new Date().toISOString(),
    methodology: { sample: SAMPLE, horizon_min: HORIZON_MIN, tp_pct: TP_PCT, sl_pct: SL_PCT, source: 'top_gainers_log' },
    candidates_processed: processed,
    outcome_distribution: outcomeStats,
    market_distribution: mktStats,
    indicators: {},
  };
  for (const [ind, samples] of Object.entries(bucket)) {
    const wins = samples.filter((s) => s.outcome === 'WIN').map((s) => s.value);
    const losses = samples.filter((s) => s.outcome === 'LOSE').map((s) => s.value);
    const all = samples.map((s) => s.value);
    output.indicators[ind] = {
      n: samples.length,
      n_wins: wins.length,
      n_losses: losses.length,
      all: { p25: quantile(all, 0.25), p50: quantile(all, 0.5), p75: quantile(all, 0.75) },
      wins: { p25: quantile(wins, 0.25), p50: quantile(wins, 0.5), p75: quantile(wins, 0.75) },
      losses: { p25: quantile(losses, 0.25), p50: quantile(losses, 0.5), p75: quantile(losses, 0.75) },
    };
  }

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outPath = path.join('out', `indicator-calibration-phase-b-${dateStr}.json`);
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Output: ${outPath}\n`);

  console.log('━━━ EMPIRICAL SUMMARY (Phase B) ━━━');
  console.log('indicator       n     p50(wins)   p50(losses)  separation   p25-p75 wins      p25-p75 losses');
  for (const ind of Object.keys(output.indicators)) {
    const o = output.indicators[ind];
    const w50 = o.wins.p50?.toFixed(3) ?? '-';
    const l50 = o.losses.p50?.toFixed(3) ?? '-';
    const sep = (o.wins.p50 !== null && o.losses.p50 !== null) ? Math.abs(o.wins.p50 - o.losses.p50).toFixed(3) : '-';
    const wQR = `[${o.wins.p25?.toFixed(2) ?? '-'},${o.wins.p75?.toFixed(2) ?? '-'}]`;
    const lQR = `[${o.losses.p25?.toFixed(2) ?? '-'},${o.losses.p75?.toFixed(2) ?? '-'}]`;
    console.log(`${ind.padEnd(15)} ${String(o.n).padStart(4)}  ${String(w50).padStart(10)}  ${String(l50).padStart(10)}  ${String(sep).padStart(8)}     ${wQR.padEnd(18)} ${lQR}`);
  }
})();
