/**
 * TP/SL sweep — trouve le couple TP/SL qui maximise l'espérance sur les
 * candidats top_gainers_log (sampling stratifié, marché réel).
 *
 * Pour chaque candidat : walk les candles post-entry UNE fois, enregistre
 * MFE/MAE + l'ordre de touch. Puis dérive l'outcome pour CHAQUE couple
 * (TP, SL) testé en un seul pass (pas de re-fetch).
 *
 * Espérance = WR × TP - (1-WR) × SL  (par trade, en %)
 *
 * Usage : EODHD_API_KEY=xxx npx tsx scripts/tp-sweep.ts --sample=5000 --horizon=60
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const EODHD_KEY = env.EODHD_API_KEY ?? process.env.EODHD_API_KEY;
if (!EODHD_KEY) { console.error('❌ EODHD_API_KEY absent'); process.exit(1); }

const SAMPLE = Number(process.argv.find((a) => a.startsWith('--sample='))?.slice('--sample='.length) ?? '5000');
const HORIZON_MIN = Number(process.argv.find((a) => a.startsWith('--horizon='))?.slice('--horizon='.length) ?? '60');
const MAX_PER_SYMBOL = Number(process.argv.find((a) => a.startsWith('--max-per-symbol='))?.slice('--max-per-symbol='.length) ?? '30');

// Couples (TP, SL) à tester
const TP_VALUES = [0.8, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
const SL_VALUES = [1.0, 1.5, 2.0];

interface Candle { ts: number; high: number; low: number; close: number; }
const cache = new Map<string, Candle[]>();

async function fetchCandles5m(symbol: string, fromTs: number, toTs: number): Promise<Candle[]> {
  const key = `${symbol}::${Math.floor(fromTs / 86400)}::${Math.floor(toTs / 86400)}`;
  const hit = cache.get(key); if (hit) return hit;
  const url = `https://eodhd.com/api/intraday/${encodeURIComponent(symbol)}?api_token=${EODHD_KEY}&interval=5m&from=${fromTs}&to=${toTs}&fmt=json`;
  try {
    const r = await fetch(url);
    if (!r.ok) { cache.set(key, []); return []; }
    const arr = await r.json() as any[];
    const candles = (arr ?? []).map((x) => ({ ts: x.timestamp * 1000, high: Number(x.high), low: Number(x.low), close: Number(x.close) }))
      .filter((c) => Number.isFinite(c.close) && c.close > 0);
    cache.set(key, candles);
    return candles;
  } catch { return []; }
}

/** Pour un couple (tp,sl) donné, walk les candles post-entry en respectant
 *  l'ordre de touch (SL prioritaire = worst case conservateur si même candle). */
function outcomeFor(post: Candle[], entry: number, tpPct: number, slPct: number): 'WIN' | 'LOSE' | 'NEUTRAL' {
  const tpPrice = entry * (1 + tpPct / 100);
  const slPrice = entry * (1 - slPct / 100);
  for (const c of post) {
    if (c.low <= slPrice) return 'LOSE';
    if (c.high >= tpPrice) return 'WIN';
  }
  const last = post[post.length - 1].close;
  if (last >= entry * 1.002) return 'WIN';
  if (last <= entry * 0.998) return 'LOSE';
  return 'NEUTRAL';
}

(async () => {
  console.log(`\n========== TP/SL SWEEP — sample=${SAMPLE} horizon=${HORIZON_MIN}min ==========\n`);

  // Stratified fetch (même logique que confluence)
  const candidates: any[] = [];
  for (let day = 0; day < 28; day++) {
    const from = new Date(Date.now() - (day + 1) * 86400_000).toISOString();
    const to = new Date(Date.now() - day * 86400_000).toISOString();
    const { data } = await sb.from('top_gainers_log')
      .select('symbol, captured_at, close_price, decision')
      .gte('captured_at', from).lt('captured_at', to)
      .in('decision', ['passed', 'opened']).limit(2000);
    if (data) candidates.push(...data);
  }
  for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
  const perSym: Record<string, number> = {};
  const sampled: any[] = [];
  for (const c of candidates) {
    if (sampled.length >= SAMPLE) break;
    const n = perSym[c.symbol] ?? 0;
    if (n >= MAX_PER_SYMBOL) continue;
    perSym[c.symbol] = n + 1;
    sampled.push(c);
  }
  console.log(`Candidates: ${sampled.length}, unique symbols: ${Object.keys(perSym).length}`);

  const bySymbol: Record<string, any[]> = {};
  for (const c of sampled) (bySymbol[c.symbol] ??= []).push(c);

  // Stats par couple (tp,sl)
  const grid: Record<string, { win: number; lose: number; neutral: number }> = {};
  for (const tp of TP_VALUES) for (const sl of SL_VALUES) grid[`${tp}/${sl}`] = { win: 0, lose: 0, neutral: 0 };

  let processed = 0, skip = 0;
  const t0 = Date.now();
  for (const [symbol, list] of Object.entries(bySymbol)) {
    const ts = list.map((c) => new Date(c.captured_at).getTime());
    const fromTs = Math.floor((Math.min(...ts) - 86400_000) / 1000);
    const toTs = Math.floor((Math.max(...ts) + (HORIZON_MIN + 60) * 60_000) / 1000);
    const candles = await fetchCandles5m(symbol, fromTs, toTs);
    if (!candles.length) { skip += list.length; continue; }
    for (const cand of list) {
      const entryTs = new Date(cand.captured_at).getTime();
      const horizonEnd = entryTs + HORIZON_MIN * 60_000;
      const post = candles.filter((c) => c.ts > entryTs && c.ts <= horizonEnd);
      if (post.length === 0) { skip++; continue; }
      const entry = Number(cand.close_price);
      for (const tp of TP_VALUES) for (const sl of SL_VALUES) {
        const o = outcomeFor(post, entry, tp, sl);
        const g = grid[`${tp}/${sl}`];
        if (o === 'WIN') g.win++; else if (o === 'LOSE') g.lose++; else g.neutral++;
      }
      processed++;
    }
    await new Promise((r) => setTimeout(r, 50));
    if (processed % 300 === 0 && processed > 0) console.log(`  ...${processed} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  console.log(`\nProcessed: ${processed}, skip: ${skip}\n`);
  console.log('━━━ GRILLE TP/SL — WR + ESPÉRANCE/trade ━━━');
  console.log('TP%   SL%    n     WR      expectancy%/trade   (win/lose/neutral)');
  const rows: any[] = [];
  for (const tp of TP_VALUES) for (const sl of SL_VALUES) {
    const g = grid[`${tp}/${sl}`];
    const decided = g.win + g.lose;
    const wr = decided > 0 ? g.win / decided : 0;
    // Espérance par trade en % (neutrals = 0 PnL, on les inclut dans le dénominateur total)
    const totalN = g.win + g.lose + g.neutral;
    const exp = totalN > 0 ? (g.win * tp - g.lose * sl) / totalN : 0;
    rows.push({ tp, sl, n: totalN, wr, exp, ...g });
    console.log(`${tp.toFixed(2)}  ${sl.toFixed(2)}  ${String(totalN).padStart(4)}  ${(wr * 100).toFixed(1).padStart(5)}%   ${exp >= 0 ? '+' : ''}${exp.toFixed(3).padStart(7)}%          (${g.win}/${g.lose}/${g.neutral})`);
  }

  rows.sort((a, b) => b.exp - a.exp);
  console.log('\n━━━ TOP 5 par espérance ━━━');
  for (const r of rows.slice(0, 5)) {
    console.log(`  TP+${r.tp}% / SL-${r.sl}% → exp ${r.exp >= 0 ? '+' : ''}${r.exp.toFixed(3)}%/trade, WR ${(r.wr * 100).toFixed(1)}% (n=${r.n})`);
  }

  const out = { generated_at: new Date().toISOString(), sample: SAMPLE, horizon_min: HORIZON_MIN, processed, grid, top: rows.slice(0, 10) };
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(path.join('out', `tp-sweep-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`), JSON.stringify(out, null, 2));
  console.log(`\n✅ Output saved.\n`);
})();
