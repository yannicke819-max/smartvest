/**
 * Phase B+ — extension confluence MFI + ROC + Volume spike.
 *
 * Test de la stratégie "pump exhaustion détecté par confluence 3 signaux" :
 *   1. MFI bearish divergence (price↑ + MFI↓ sur window 15 candles 5m)
 *   2. ROC flattening (ROC(5) declining trend sur 6 candles)
 *   3. Volume spike fading (peak vol > 1.8× MA20 puis current vol < peak × 0.6)
 *
 * Règle confluence : SKIP candidat si ≥2/3 signaux fire = pump est "mort"
 *
 * Mesure : WR avant vs après filtre confluence sur nos 1518 candidats Phase B.
 * Source : top_gainers_log historique.
 *
 * Usage : EODHD_API_KEY=xxx npx tsx scripts/recalc-indicators-confluence.ts --sample=5000
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
const SAMPLE = Number(process.argv.find((a) => a.startsWith('--sample='))?.slice('--sample='.length) ?? '5000');
const HORIZON_MIN = Number(process.argv.find((a) => a.startsWith('--horizon='))?.slice('--horizon='.length) ?? '60');
const TP_PCT = Number(process.argv.find((a) => a.startsWith('--tp='))?.slice('--tp='.length) ?? '2.0');
const SL_PCT = Number(process.argv.find((a) => a.startsWith('--sl='))?.slice('--sl='.length) ?? '1.5');

console.log(`Settings: sample=${SAMPLE} horizon=${HORIZON_MIN}min TP=+${TP_PCT}% SL=-${SL_PCT}%`);

// ============================================================
// Types & Indicateurs
// ============================================================
interface Candle { ts: number; open: number; high: number; low: number; close: number; volume: number; }

/** MFI(14) = Money Flow Index — RSI weighted by volume. Source : FXTrendo academic, MFI > RSI pour scalp pump. */
function mfi(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  let pos = 0, neg = 0;
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const start = candles.length - period - 1;
  for (let i = start + 1; i < candles.length; i++) {
    const rmf = tp[i] * candles[i].volume;
    if (tp[i] > tp[i - 1]) pos += rmf;
    else if (tp[i] < tp[i - 1]) neg += rmf;
  }
  if (neg === 0) return 100;
  const mfr = pos / neg;
  return 100 - 100 / (1 + mfr);
}

/** ROC(n) = Rate of Change = ((close - close_n_ago) / close_n_ago) * 100. */
function roc(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const prev = closes[closes.length - 1 - n];
  if (prev <= 0) return null;
  return ((closes[closes.length - 1] - prev) / prev) * 100;
}

/** Série ROC sur les K dernières valeurs pour détecter slope. */
function rocSeries(closes: number[], n: number, k: number): number[] {
  const out: number[] = [];
  for (let i = closes.length - k; i < closes.length; i++) {
    if (i - n < 0) continue;
    out.push(((closes[i] - closes[i - n]) / closes[i - n]) * 100);
  }
  return out;
}

/** Slope linéaire d'une série (least squares). */
function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += values[i]; sxy += i * values[i]; sxx += i * i; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

// ============================================================
// Confluence signals
// ============================================================

/** Signal 1 : MFI bearish divergence sur window 15 candles. */
function mfiDivergence(candles: Candle[], windowSize = 15): { triggered: boolean; details?: string } {
  if (candles.length < windowSize + 14) return { triggered: false };
  const window = candles.slice(-windowSize);
  // Trouve peak price dans window (hors dernière candle)
  let peakIdx = 0;
  for (let i = 1; i < window.length - 1; i++) {
    if (window[i].close > window[peakIdx].close) peakIdx = i;
  }
  const peakClose = window[peakIdx].close;
  const lastClose = window[window.length - 1].close;
  // Need price higher now (continuation/equal high)
  if (lastClose < peakClose * 0.998) return { triggered: false };
  // MFI au peak vs MFI au dernier
  const allCloses = candles.slice(0, candles.length - (windowSize - peakIdx - 1));
  const mfiPeak = mfi(allCloses.slice(0, peakIdx + 1 + (candles.length - windowSize)));
  const mfiNow = mfi(candles);
  if (mfiPeak === null || mfiNow === null) return { triggered: false };
  // Diverge si MFI now < MFI peak ET MFI était overbought (>70) au peak
  if (mfiPeak > 70 && mfiNow < mfiPeak - 5) {
    return { triggered: true, details: `MFI peak=${mfiPeak.toFixed(1)} → now=${mfiNow.toFixed(1)} (Δ ${(mfiNow - mfiPeak).toFixed(1)})` };
  }
  return { triggered: false };
}

/** Signal 2 : ROC flattening = ROC(5) trending négatif sur 6 dernières candles, mais reste positif. */
function rocFlattening(closes: number[]): { triggered: boolean; details?: string } {
  if (closes.length < 12) return { triggered: false };
  const series = rocSeries(closes, 5, 6); // ROC(5) sur 6 candles = 30min context
  if (series.length < 6) return { triggered: false };
  const s = slope(series);
  const last = series[series.length - 1];
  // Flattening : slope négatif ET ROC encore positif (sinon c'est juste déjà mort)
  if (s < -0.05 && last > 0) {
    return { triggered: true, details: `ROC slope=${s.toFixed(3)} (declining), last ROC=${last.toFixed(2)}%` };
  }
  return { triggered: false };
}

/** Signal 3 : Volume spike fading = peak volume > 1.8× MA20 puis current vol < peak × 0.6. */
function volumeFading(candles: Candle[]): { triggered: boolean; details?: string } {
  if (candles.length < 21) return { triggered: false };
  const recent = candles.slice(-6);
  const ma20 = candles.slice(-26, -6).reduce((a, c) => a + c.volume, 0) / 20;
  if (ma20 <= 0) return { triggered: false };
  const peakVol = Math.max(...recent.slice(0, -1).map((c) => c.volume));
  const currentVol = recent[recent.length - 1].volume;
  // Spike confirmé ET fading
  if (peakVol > ma20 * 1.8 && currentVol < peakVol * 0.6) {
    return {
      triggered: true,
      details: `peak vol=${peakVol.toFixed(0)} (${(peakVol / ma20).toFixed(1)}× MA20), now=${currentVol.toFixed(0)} (${((currentVol / peakVol) * 100).toFixed(0)}% of peak)`,
    };
  }
  return { triggered: false };
}

interface ConfluenceResult {
  signal1_mfi_div: boolean;
  signal2_roc_flat: boolean;
  signal3_vol_fade: boolean;
  count: number; // 0-3
  triggered: boolean; // count >= 2
  details: string[];
}

function evaluateConfluence(candles: Candle[]): ConfluenceResult {
  const closes = candles.map((c) => c.close);
  const s1 = mfiDivergence(candles);
  const s2 = rocFlattening(closes);
  const s3 = volumeFading(candles);
  const count = [s1.triggered, s2.triggered, s3.triggered].filter(Boolean).length;
  const details: string[] = [];
  if (s1.triggered) details.push(`MFI_DIV: ${s1.details}`);
  if (s2.triggered) details.push(`ROC_FLAT: ${s2.details}`);
  if (s3.triggered) details.push(`VOL_FADE: ${s3.details}`);
  return { signal1_mfi_div: s1.triggered, signal2_roc_flat: s2.triggered, signal3_vol_fade: s3.triggered, count, triggered: count >= 2, details };
}

// ============================================================
// EODHD fetcher + outcome simulator (same as Phase B)
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
      ts: x.timestamp * 1000, open: Number(x.open), high: Number(x.high), low: Number(x.low),
      close: Number(x.close), volume: Number(x.volume ?? 0),
    })).filter((c) => Number.isFinite(c.close) && c.close > 0);
    candleCache.set(key, candles);
    return candles;
  } catch { return []; }
}

function simulateOutcome(candles: Candle[], entryTs: number, entryPrice: number, horizonMin: number, tpPct: number, slPct: number): 'WIN' | 'LOSE' | 'NEUTRAL' | 'NO_DATA' {
  const horizonEnd = entryTs + horizonMin * 60_000;
  const post = candles.filter((c) => c.ts > entryTs && c.ts <= horizonEnd);
  if (post.length === 0) return 'NO_DATA';
  const tpPrice = entryPrice * (1 + tpPct / 100);
  const slPrice = entryPrice * (1 - slPct / 100);
  for (const c of post) {
    if (c.low <= slPrice) return 'LOSE';
    if (c.high >= tpPrice) return 'WIN';
  }
  const finalClose = post[post.length - 1].close;
  if (finalClose >= entryPrice * 1.005) return 'WIN';
  if (finalClose <= entryPrice * 0.995) return 'LOSE';
  return 'NEUTRAL';
}

// ============================================================
// Main
// ============================================================
(async () => {
  console.log(`\n========== PHASE B+ — CONFLUENCE BACKTEST ==========\n`);

  // 1. Fetch candidates (same logic Phase B)
  const since = new Date(Date.now() - 28 * 86400_000).toISOString();
  const candidates: any[] = [];
  let pageFrom = 0, pageSize = 1000;
  while (candidates.length < SAMPLE) {
    const { data, error } = await sb.from('top_gainers_log')
      .select('symbol, captured_at, close_price, change_pct, market, decision')
      .gte('captured_at', since).in('decision', ['passed', 'opened'])
      .order('captured_at', { ascending: true }).range(pageFrom, pageFrom + pageSize - 1);
    if (error || !data || data.length === 0) break;
    candidates.push(...data);
    if (data.length < pageSize) break;
    pageFrom += pageSize;
  }
  console.log(`Candidates: ${candidates.length}`);
  if (candidates.length > SAMPLE) {
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    candidates.length = SAMPLE;
  }

  // 2. Group + process
  const bySymbol: Record<string, any[]> = {};
  for (const c of candidates) (bySymbol[c.symbol] ??= []).push(c);
  console.log(`Unique symbols: ${Object.keys(bySymbol).length}`);

  // Stats
  const baseline = { WIN: 0, LOSE: 0, NEUTRAL: 0 };
  const filtered_pass = { WIN: 0, LOSE: 0, NEUTRAL: 0 }; // ce qui passe le filtre (≤1 signal)
  const filtered_block = { WIN: 0, LOSE: 0, NEUTRAL: 0 }; // ce qui est bloqué (≥2 signaux)
  const bySignalCount: Record<string, { WIN: number; LOSE: number; NEUTRAL: number }> = {
    '0': { WIN: 0, LOSE: 0, NEUTRAL: 0 },
    '1': { WIN: 0, LOSE: 0, NEUTRAL: 0 },
    '2': { WIN: 0, LOSE: 0, NEUTRAL: 0 },
    '3': { WIN: 0, LOSE: 0, NEUTRAL: 0 },
  };
  const bySignalIndividual: Record<string, { triggered: number; win_rate: number; n_win: number; n_total: number }> = {
    mfi_div: { triggered: 0, win_rate: 0, n_win: 0, n_total: 0 },
    roc_flat: { triggered: 0, win_rate: 0, n_win: 0, n_total: 0 },
    vol_fade: { triggered: 0, win_rate: 0, n_win: 0, n_total: 0 },
  };

  let processed = 0, skipNoData = 0;
  const t0 = Date.now();
  for (const [symbol, list] of Object.entries(bySymbol)) {
    const ts = list.map((c) => new Date(c.captured_at).getTime());
    const fromTs = Math.floor((Math.min(...ts) - 86400_000) / 1000);
    const toTs = Math.floor((Math.max(...ts) + (HORIZON_MIN + 60) * 60_000) / 1000);
    const candles = await fetchCandles5m(symbol, fromTs, toTs);
    if (!candles.length) continue;

    for (const cand of list) {
      const entryTs = new Date(cand.captured_at).getTime();
      // Slice candles up to entry
      const idx = candles.findIndex((c) => c.ts > entryTs);
      const upTo = idx > 0 ? candles.slice(0, idx) : candles;
      if (upTo.length < 30) continue;

      const conf = evaluateConfluence(upTo);
      const entryPrice = Number(cand.close_price);
      const outcome = simulateOutcome(candles, entryTs, entryPrice, HORIZON_MIN, TP_PCT, SL_PCT);
      if (outcome === 'NO_DATA') { skipNoData++; continue; }

      baseline[outcome]++;
      if (conf.triggered) filtered_block[outcome]++;
      else filtered_pass[outcome]++;

      bySignalCount[String(conf.count)][outcome]++;

      // Individual signal stats
      if (conf.signal1_mfi_div) { bySignalIndividual.mfi_div.triggered++; bySignalIndividual.mfi_div.n_total++; if (outcome === 'WIN') bySignalIndividual.mfi_div.n_win++; }
      if (conf.signal2_roc_flat) { bySignalIndividual.roc_flat.triggered++; bySignalIndividual.roc_flat.n_total++; if (outcome === 'WIN') bySignalIndividual.roc_flat.n_win++; }
      if (conf.signal3_vol_fade) { bySignalIndividual.vol_fade.triggered++; bySignalIndividual.vol_fade.n_total++; if (outcome === 'WIN') bySignalIndividual.vol_fade.n_win++; }

      processed++;
    }
    await new Promise((res) => setTimeout(res, 50));
    if (processed % 200 === 0 && processed > 0) {
      const e = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  ...${processed} in ${e}s`);
    }
  }

  for (const k of Object.keys(bySignalIndividual)) {
    const s = bySignalIndividual[k];
    s.win_rate = s.n_total > 0 ? s.n_win / s.n_total : 0;
  }

  console.log(`\nProcessed: ${processed} in ${((Date.now() - t0) / 1000).toFixed(0)}s, skip NO_DATA: ${skipNoData}\n`);

  const wr = (b: any) => b.WIN + b.LOSE > 0 ? b.WIN / (b.WIN + b.LOSE) : null;
  const total = (b: any) => b.WIN + b.LOSE + b.NEUTRAL;

  const baselineN = total(baseline), baselineWR = wr(baseline);
  const passN = total(filtered_pass), passWR = wr(filtered_pass);
  const blockN = total(filtered_block), blockWR = wr(filtered_block);

  console.log('━━━ BASELINE (sans filtre confluence) ━━━');
  console.log(`  n=${baselineN}, WR=${((baselineWR ?? 0) * 100).toFixed(1)}% (${baseline.WIN} WIN / ${baseline.LOSE} LOSE / ${baseline.NEUTRAL} NEUTRAL)`);

  console.log('\n━━━ APRÈS FILTRE CONFLUENCE ≥2/3 ━━━');
  console.log(`  PASS (≤1 signal): n=${passN}, WR=${((passWR ?? 0) * 100).toFixed(1)}% (${filtered_pass.WIN} WIN / ${filtered_pass.LOSE} LOSE / ${filtered_pass.NEUTRAL} NEUTRAL)`);
  console.log(`  BLOCK (≥2 signaux pump_dead): n=${blockN}, WR=${((blockWR ?? 0) * 100).toFixed(1)}% (${filtered_block.WIN} WIN / ${filtered_block.LOSE} LOSE / ${filtered_block.NEUTRAL} NEUTRAL)`);
  if (baselineWR && passWR) {
    const delta = (passWR - baselineWR) * 100;
    console.log(`\n  → DELTA WR PASS vs baseline: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} points`);
    const blockRate = blockN / baselineN;
    console.log(`  → % candidates bloqués: ${(blockRate * 100).toFixed(1)}%`);
  }

  console.log('\n━━━ Breakdown par nombre de signaux ━━━');
  for (const k of ['0', '1', '2', '3']) {
    const b = bySignalCount[k];
    const n = total(b), w = wr(b);
    console.log(`  ${k} signal(s): n=${n.toString().padStart(4)} WR=${w !== null ? ((w * 100).toFixed(1) + '%').padStart(6) : '  n/a '} (${b.WIN}W / ${b.LOSE}L / ${b.NEUTRAL}N)`);
  }

  console.log('\n━━━ Signal individuel WR ━━━');
  for (const [k, s] of Object.entries(bySignalIndividual)) {
    console.log(`  ${k.padEnd(10)}: triggered ${s.triggered.toString().padStart(4)}× | WR quand triggered = ${(s.win_rate * 100).toFixed(1)}% (${s.n_win}/${s.n_total})`);
  }

  // Output JSON
  const output = {
    generated_at: new Date().toISOString(),
    methodology: { sample: SAMPLE, horizon_min: HORIZON_MIN, tp_pct: TP_PCT, sl_pct: SL_PCT, source: 'top_gainers_log + confluence MFI/ROC/Volume' },
    processed,
    baseline, baseline_wr: baselineWR,
    filtered_pass, filtered_pass_wr: passWR,
    filtered_block, filtered_block_wr: blockWR,
    by_signal_count: bySignalCount,
    by_signal_individual: bySignalIndividual,
  };
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outPath = path.join('out', `indicator-confluence-${dateStr}.json`);
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Output: ${outPath}\n`);
})();
