/**
 * Phase 2 — Percentile-based SL/TP recalibration per asset_class.
 *
 * Reuses helpers from analyze-mfe-mae.ts (fetchTrades, fetchCandles, computeMetrics).
 * Computes MAE & MFE distributions per class → derives:
 *   - SL optimal = |P85(MAE)| × 1.1
 *   - TP optimal = P70(MFE)
 *   - Break-even trigger = P50(MFE on winners)
 *
 * Applies UPDATE asset_class_tpsl_config + persists scanner_lessons.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import 'dotenv/config';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const EOD_KEY = process.env.EODHD_API_KEY || '69e6325aa2c162.98850425';

const SINCE = '2026-05-06';
const HARD_LIMIT = 500;

const APPLY = process.argv.includes('--apply');

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

async function supaGet(path: string): Promise<any> {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
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

async function supaPatch(path: string, body: any): Promise<any> {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path}: ${res.status} ${await res.text()}`);
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
  return 'other';
}

function cryptoToEodhd(sym: string): string | null {
  const up = sym.toUpperCase();
  if (/\.CC$/.test(up)) return up;
  const m = up.match(/^([A-Z]+)USDT?$/);
  if (m) return `${m[1]}-USD.CC`;
  return null;
}

async function fetchEodhd(symbol: string, fromUnix: number, toUnix: number, interval: '1m' | '5m'): Promise<Candle[]> {
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
    const eodSym = cryptoToEodhd(trade.symbol);
    if (eodSym) {
      let c = await fetchEodhd(eodSym, from, to, interval);
      if (c.length === 0 && interval === '5m') c = await fetchEodhd(eodSym, from, to, '1m');
      if (c.length) return c;
    }
    return [];
  }
  let candles = await fetchEodhd(trade.symbol, from, to, interval);
  if (candles.length === 0 && interval === '5m') {
    candles = await fetchEodhd(trade.symbol, from, to, '1m');
  }
  return candles;
}

type TradeMetrics = {
  trade: Trade;
  mfe_pct: number;
  mae_pct: number; // signed: negative for long losers (drawdown side)
  exit_bucket: string;
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
  const sign = isLong ? 1 : -1;
  const mfe_price = isLong ? maxHigh : minLow;
  const mae_price = isLong ? minLow : maxHigh;
  const mfe_pct = (sign * (mfe_price - entry)) / entry * 100;
  const mae_pct = (sign * (mae_price - entry)) / entry * 100;

  return {
    trade,
    mfe_pct,
    mae_pct,
    exit_bucket: categorizeExit(trade.exit_reason),
  };
}

async function withConcurrency<T, R>(items: T[], concurrency: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      if (idx >= items.length) break;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch {
        results[idx] = undefined as any;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function median(arr: number[]): number {
  return percentile(arr, 0.5);
}

function fmt(n: number, d = 2): string {
  return isFinite(n) ? n.toFixed(d) : '—';
}

/* ----------------------- Recalibration logic ----------------------- */

type Recalibration = {
  asset_class: string;
  n: number;
  n_winners: number;
  mae_p25: number;
  mae_p50: number;
  mae_p70: number;
  mae_p75: number;
  mae_p85: number;
  mfe_p25: number;
  mfe_p50: number;
  mfe_p70: number;
  mfe_p75: number;
  mfe_p85: number;
  mfe_p50_winners: number;
  sl_actual_pct: number; // signed decimal, e.g. -0.01
  tp_actual_pct: number; // decimal
  sl_proposed_pct: number;
  tp_proposed_pct: number;
  be_proposed_pct: number;
  low_confidence: boolean;
  skip_reason?: string;
};

const SL_MIN_PCT = 0.5;
const SL_MAX_PCT = 3.0;
const TP_MIN_PCT = 1.5;
const TP_MAX_PCT = 8.0;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

async function main() {
  console.log(`\n=== Phase 2: Percentile-based SL/TP recalibration (since ${SINCE}) ===\n`);
  console.log(`Mode: ${APPLY ? '🟢 APPLY (DB updates ON)' : '🟡 DRY-RUN (pass --apply to write)'}\n`);

  // Load current config
  const currentCfg: any[] = await supaGet('asset_class_tpsl_config?select=asset_class,tp_pct,sl_pct');
  const cfgMap = new Map<string, { tp: number; sl: number }>();
  for (const r of currentCfg) {
    cfgMap.set(r.asset_class, { tp: Number(r.tp_pct), sl: Number(r.sl_pct) });
  }

  const trades = await fetchTrades();
  const valid = trades.filter((t) => t.exit_timestamp && t.entry_price);
  console.log(`Fetched ${trades.length} closed trades, ${valid.length} valid\n`);

  let processed = 0;
  let lastLog = Date.now();
  const start = Date.now();

  const metrics: (TradeMetrics | null)[] = await withConcurrency(valid, 12, async (t) => {
    try {
      const c = await fetchCandles(t);
      const m = computeMetrics(t, c);
      processed++;
      if (Date.now() - lastLog > 5000) {
        console.log(`  progress: ${processed}/${valid.length} (${Math.round((Date.now() - start) / 1000)}s)`);
        lastLog = Date.now();
      }
      return m;
    } catch {
      processed++;
      return null;
    }
  });

  const ok = metrics.filter((m): m is TradeMetrics => m !== null);
  console.log(`\nClassified: ${ok.length} / Skipped: ${metrics.length - ok.length}\n`);

  // Group by asset_class
  const byClass = new Map<string, TradeMetrics[]>();
  for (const m of ok) {
    const k = m.trade.asset_class || 'unknown';
    if (!byClass.has(k)) byClass.set(k, []);
    byClass.get(k)!.push(m);
  }

  // Compute recalibration per class
  const recalibs: Recalibration[] = [];
  for (const [cls, arr] of byClass) {
    const maeAbs = arr.map((m) => Math.abs(m.mae_pct));
    const mfeAll = arr.map((m) => m.mfe_pct);
    const winners = arr.filter((m) => m.exit_bucket === 'TP_HIT');
    const mfeWinners = winners.map((m) => m.mfe_pct);

    const cfg = cfgMap.get(cls);
    const sl_actual = cfg ? cfg.sl : NaN;
    const tp_actual = cfg ? cfg.tp : NaN;

    const mae_p85 = percentile(maeAbs, 0.85);
    const mfe_p70 = percentile(mfeAll, 0.70);
    const mfe_p50_win = median(mfeWinners);

    const sl_raw_pct = mae_p85 * 1.1; // in percent units
    const tp_raw_pct = mfe_p70;
    const be_raw_pct = isFinite(mfe_p50_win) ? mfe_p50_win : NaN;

    const sl_proposed = clamp(sl_raw_pct, SL_MIN_PCT, SL_MAX_PCT);
    const tp_proposed = clamp(tp_raw_pct, TP_MIN_PCT, TP_MAX_PCT);

    const low_confidence = arr.length < 20;
    let skip_reason: string | undefined;
    if (low_confidence) skip_reason = `n=${arr.length}<20 low_confidence`;
    if (cls === 'crypto_major') skip_reason = 'crypto_major skipped (already disabled, n typically small)';
    if (cls === 'us_equity_large' && cfg && Math.abs(cfg.sl) >= 0.009 && Math.abs(cfg.sl) <= 0.011) {
      // healthy from Phase 1 analysis
      skip_reason = (skip_reason ? skip_reason + '; ' : '') + 'us_equity_large MAE/R 0.57 healthy per Phase 1';
    }

    recalibs.push({
      asset_class: cls,
      n: arr.length,
      n_winners: winners.length,
      mae_p25: percentile(maeAbs, 0.25),
      mae_p50: percentile(maeAbs, 0.50),
      mae_p70: percentile(maeAbs, 0.70),
      mae_p75: percentile(maeAbs, 0.75),
      mae_p85,
      mfe_p25: percentile(mfeAll, 0.25),
      mfe_p50: percentile(mfeAll, 0.50),
      mfe_p70,
      mfe_p75: percentile(mfeAll, 0.75),
      mfe_p85: percentile(mfeAll, 0.85),
      mfe_p50_winners: mfe_p50_win,
      sl_actual_pct: sl_actual,
      tp_actual_pct: tp_actual,
      sl_proposed_pct: sl_proposed / 100, // back to decimal
      tp_proposed_pct: tp_proposed / 100,
      be_proposed_pct: be_raw_pct,
      low_confidence,
      skip_reason,
    });
  }

  /* ------ Table 1: percentiles per class ------ */
  console.log('## 1. Percentile distributions (MAE = absolute drawdown %, MFE = excursion %)');
  console.log('| asset_class | n | n_win | MAE P25 | MAE P50 | MAE P70 | MAE P75 | MAE P85 | MFE P25 | MFE P50 | MFE P70 | MFE P75 | MFE P85 | MFE P50_win |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of recalibs.sort((a, b) => b.n - a.n)) {
    console.log(
      `| ${r.asset_class} | ${r.n} | ${r.n_winners} | ${fmt(r.mae_p25)} | ${fmt(r.mae_p50)} | ${fmt(r.mae_p70)} | ${fmt(r.mae_p75)} | ${fmt(r.mae_p85)} | ${fmt(r.mfe_p25)} | ${fmt(r.mfe_p50)} | ${fmt(r.mfe_p70)} | ${fmt(r.mfe_p75)} | ${fmt(r.mfe_p85)} | ${fmt(r.mfe_p50_winners)} |`,
    );
  }
  console.log();

  /* ------ Table 2: recalibration ------ */
  console.log('## 2. Recalibration applied (SL/TP in %)');
  console.log('| asset_class | n | SL actual | SL proposed | TP actual | TP proposed | BE trigger | Action |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of recalibs.sort((a, b) => b.n - a.n)) {
    const action = r.skip_reason ? `SKIP (${r.skip_reason})` : 'APPLY';
    console.log(
      `| ${r.asset_class} | ${r.n} | ${fmt(Math.abs(r.sl_actual_pct) * 100)}% | ${fmt(r.sl_proposed_pct * 100)}% | ${fmt(r.tp_actual_pct * 100)}% | ${fmt(r.tp_proposed_pct * 100)}% | ${fmt(r.be_proposed_pct)}% | ${action} |`,
    );
  }
  console.log();

  /* ------ Effet projeté ------ */
  console.log('## 3. Projected effect — simulate proposed SL/TP on the 3-week sample');
  let totalProjectedDelta = 0;
  for (const r of recalibs) {
    if (r.skip_reason) continue;
    const arr = byClass.get(r.asset_class)!;
    let saved = 0;
    let lost = 0;
    let n_changed = 0;
    for (const m of arr) {
      const notional = parseFloat(m.trade.entry_notional_usd || '0');
      if (notional <= 0) continue;
      const slProposed = r.sl_proposed_pct * 100;
      const tpProposed = r.tp_proposed_pct * 100;
      const slActual = Math.abs(r.sl_actual_pct) * 100;
      const tpActual = r.tp_actual_pct * 100;
      // Heuristic: if SL was hit at actual but MAE wouldn't reach new SL → trade survives
      if (m.exit_bucket === 'SL_HIT' && Math.abs(m.mae_pct) < slProposed && m.mfe_pct >= tpProposed) {
        // would now hit TP (saved + tp_proposed)
        const realized = parseFloat(m.trade.realized_pnl_pct || '0');
        const delta = (tpProposed - realized) / 100 * notional;
        saved += delta;
        n_changed++;
      } else if (m.exit_bucket === 'TP_HIT' && tpProposed > tpActual && m.mfe_pct < tpProposed) {
        // TP widened but mfe didn't reach → would have stayed open longer, conservatively assume same realized
        // (no change)
      } else if (m.exit_bucket === 'TP_HIT' && tpProposed < tpActual && m.mfe_pct >= tpProposed) {
        // TP tightened → would have hit earlier (no PnL change, but faster exit)
      } else if (m.exit_bucket !== 'SL_HIT' && Math.abs(m.mae_pct) >= slProposed && m.mfe_pct < tpProposed) {
        // would now be SL-stopped where before it wasn't
        const realized = parseFloat(m.trade.realized_pnl_pct || '0');
        const delta = (-slProposed - realized) / 100 * notional;
        lost += delta;
        n_changed++;
      }
    }
    const net = saved + lost;
    totalProjectedDelta += net;
    console.log(`  ${r.asset_class}: ${n_changed} trades changed, saved $${fmt(saved)}, lost $${fmt(lost)}, net $${fmt(net)}`);
  }
  console.log(`  TOTAL projected net: $${fmt(totalProjectedDelta)}`);
  console.log();

  /* ------ Apply UPDATEs ------ */
  if (APPLY) {
    console.log('## 4. Applying UPDATE asset_class_tpsl_config');
    for (const r of recalibs) {
      if (r.skip_reason) {
        console.log(`  SKIP ${r.asset_class} (${r.skip_reason})`);
        continue;
      }
      try {
        const slSigned = -Math.abs(r.sl_proposed_pct);
        const notes = `Recalibration percentile-based P85(MAE)×1.1=${fmt(r.sl_proposed_pct * 100)}% / P70(MFE)=${fmt(r.tp_proposed_pct * 100)}% 27/05/2026 Phase 2 (n=${r.n}, n_win=${r.n_winners})`;
        await supaPatch(`asset_class_tpsl_config?asset_class=eq.${r.asset_class}`, {
          sl_pct: slSigned,
          tp_pct: r.tp_proposed_pct,
          notes,
        });
        console.log(`  ✅ ${r.asset_class}: sl_pct=${slSigned.toFixed(4)} tp_pct=${r.tp_proposed_pct.toFixed(4)}`);
      } catch (e: any) {
        console.error(`  ❌ ${r.asset_class}: ${e.message}`);
      }
    }
    console.log();
  } else {
    console.log('## 4. (DRY-RUN — pass --apply to write UPDATE)\n');
  }

  /* ------ Persist lessons ------ */
  console.log('## 5. Persisting lessons → scanner_lessons');
  const lessons: any[] = [];
  for (const r of recalibs) {
    if (r.low_confidence || r.n < 20) continue;
    const conf = r.n >= 50 ? 0.85 : 0.70;
    const lessonText = r.skip_reason
      ? `Recalibration SKIPPED ${r.asset_class}: ${r.skip_reason}. Distribution: MAE P85=${fmt(r.mae_p85)}%, MFE P70=${fmt(r.mfe_p70)}%. Sample n=${r.n}.`
      : `Recalibration ${r.asset_class}: SL optimal P85(MAE)×1.1 = ${fmt(r.sl_proposed_pct * 100)}% (avant ${fmt(Math.abs(r.sl_actual_pct) * 100)}%), TP optimal P70(MFE) = ${fmt(r.tp_proposed_pct * 100)}% (avant ${fmt(r.tp_actual_pct * 100)}%). BE trigger recommandé = ${fmt(r.be_proposed_pct)}% (MFE P50 winners). Applied ${APPLY ? '27/05/2026 Phase 2' : 'DRY-RUN'}. Sample n=${r.n} (n_winners=${r.n_winners}).`;
    lessons.push({
      derived_from_date: new Date().toISOString().slice(0, 10),
      lesson_kind: 'gate_calibration',
      scope: r.asset_class,
      macro_condition: null,
      confidence: conf,
      sample_size: r.n,
      lesson_text: lessonText,
      proposed_config_change: null,
      is_active: true,
      applied: APPLY && !r.skip_reason,
      applied_by: APPLY && !r.skip_reason ? 'phase2_agent' : null,
      applied_at: APPLY && !r.skip_reason ? new Date().toISOString() : null,
      payload: {
        mae_p25: r.mae_p25, mae_p50: r.mae_p50, mae_p70: r.mae_p70, mae_p75: r.mae_p75, mae_p85: r.mae_p85,
        mfe_p25: r.mfe_p25, mfe_p50: r.mfe_p50, mfe_p70: r.mfe_p70, mfe_p75: r.mfe_p75, mfe_p85: r.mfe_p85,
        mfe_p50_winners: r.mfe_p50_winners,
        sl_actual: r.sl_actual_pct, sl_proposed: r.sl_proposed_pct,
        tp_actual: r.tp_actual_pct, tp_proposed: r.tp_proposed_pct,
        be_proposed_pct: r.be_proposed_pct,
        n_winners: r.n_winners,
        skip_reason: r.skip_reason ?? null,
      },
    });
  }

  if (lessons.length === 0) {
    console.log('  (no lessons to persist — all classes had n<20)');
  } else if (!APPLY) {
    console.log(`  DRY-RUN: would insert ${lessons.length} lessons. Pass --apply to persist.`);
  } else {
    try {
      const inserted = await supaPost('scanner_lessons', lessons);
      console.log(`  ✅ Inserted ${inserted.length} lessons`);
      for (const l of inserted) {
        console.log(`    - ${l.id} (${l.scope}/${l.sample_size}, applied=${l.applied}): ${l.lesson_text.slice(0, 90)}…`);
      }
    } catch (e: any) {
      console.error(`  ❌ Insert failed: ${e.message}`);
    }
  }
  console.log();

  /* ------ Break-even trigger recommendation ------ */
  console.log('## 6. Break-even trigger recommendation');
  console.log('  Current env: GAINERS_TRAILING_STOP_ACTIVATION_PCT=0.003 (0.30%) — hardcoded default');
  console.log('  GAINERS_TRAILING_STOP_LOCK_PCT=0.0005 (0.05%) — lock margin');
  console.log('  Recommended: median(MFE on winners) across all classes (weighted):');
  const allWinners = ok.filter((m) => m.exit_bucket === 'TP_HIT');
  const allMfeWin = allWinners.map((m) => m.mfe_pct);
  const beGlobal = median(allMfeWin) / 2; // trigger at half the winners' median MFE peak
  console.log(`  → GAINERS_TRAILING_STOP_ACTIVATION_PCT = ${(beGlobal / 100).toFixed(4)} (${fmt(beGlobal)}%) (= ½ of MFE P50 winners = ${fmt(median(allMfeWin))}%)`);
  console.log(`  Rationale: trigger BE protection at half-way of the typical winner's peak — captures MAE recovery without choking winners early.`);
  console.log();

  console.log('## 7. Caveats');
  console.log('  - Sample 3 weeks = small, recalibration provisional. Re-run after 6 weeks for stability.');
  console.log('  - MAE distributions are right-skewed (fat tails) → P85 may underestimate true risk on quiet weeks.');
  console.log('  - asia_equity had ~52% skip rate in Phase 1 (EODHD intraday gaps) → partial data, treat with prudence.');
  console.log('  - Projected effect uses simplified heuristic (does not re-simulate trailing stops, BE, FADE Gemini).');
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
