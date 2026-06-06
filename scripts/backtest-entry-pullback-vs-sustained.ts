/**
 * Backtest d'ARBITRAGE entrée — Piste A (pullback) vs Piste B (sustained+liquide).
 *
 * Question : le signal "top gainer" achète des fades. Quel changement de RÈGLE
 * D'ENTRÉE (timing pullback OU sélection liquide/soutenue) produit enfin du
 * forward-return positif ?
 *
 * Méthode disciplinée — 5 bras sur LE MÊME univers de candidats (decision=passed),
 * MÊME fonction d'outcome (EODHD 5m, horizon 60min, TP+3/SL-1.5), pour comparer
 * sans cherry-pick :
 *   - baseline  : entrée au signal (close de la bougie contenant T)
 *   - A         : pullback — après T, attendre une bougie rouge puis verte, entrer
 *   - B1        : liquide — market_cap >= MCAP_MIN, entrée au signal
 *   - B2        : liquide + soutenu (non-parabolique, multi-barres) au signal
 *   - A_inter_B1: pullback ET liquide
 *
 * On reporte : n, taux de fill/qualif, WR (TP/SL), expectancy, forward-return
 * brut (médiane+moyenne), MFE/MAE médian. Le forward-return brut est l'edge le
 * plus propre (TP/SL peut masquer).
 *
 * Usage : npx tsx scripts/backtest-entry-pullback-vs-sustained.ts [--days=21] [--mcap=2] [--horizon=60]
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((a: any, l: string) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) a[m[1]] = m[2]; return a;
}, {});
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const KEY = env.EODHD_API_KEY;
const arg = (k: string, d: string) => process.argv.find(a => a.startsWith('--' + k + '='))?.slice(k.length + 3) ?? d;

const DAYS = +arg('days', '21');
const MCAP_MIN = +arg('mcap', '2') * 1e9;   // seuil "liquide" en $ (default $2B)
const HORIZON = +arg('horizon', '60');       // minutes
const TP = 3, SL = 1.5;
const MARKETS = ['us_equity_small_mid', 'us_equity_large', 'eu_equity'];

type Candle = { ts: number; high: number; low: number; close: number };
const cache = new Map<string, Candle[]>();
async function candles(sym: string, fromS: number, toS: number): Promise<Candle[]> {
  if (cache.has(sym)) return cache.get(sym)!;
  try {
    const r = await fetch(`https://eodhd.com/api/intraday/${encodeURIComponent(sym)}?api_token=${KEY}&interval=5m&from=${fromS}&to=${toS}&fmt=json`);
    if (!r.ok) { cache.set(sym, []); return []; }
    const a = ((await r.json()) as any[]).map(x => ({ ts: x.timestamp * 1000, high: +x.high, low: +x.low, close: +x.close })).filter(c => c.close > 0).sort((x, y) => x.ts - y.ts);
    cache.set(sym, a); return a;
  } catch { cache.set(sym, []); return []; }
}

// outcome depuis un prix d'entrée E sur HORIZON minutes
function simulate(post: Candle[], E: number) {
  const tp = E * (1 + TP / 100), sl = E * (1 - SL / 100);
  let verdict: 'WIN' | 'LOSE' | 'NEUTRAL' = 'NEUTRAL';
  let hiMax = E, loMin = E;
  for (const c of post) {
    hiMax = Math.max(hiMax, c.high); loMin = Math.min(loMin, c.low);
    if (verdict === 'NEUTRAL') {
      if (c.low <= sl) verdict = 'LOSE';        // SL prioritaire (conservateur, même bougie)
      else if (c.high >= tp) verdict = 'WIN';
    }
  }
  const lastClose = post[post.length - 1].close;
  const fwd = (lastClose - E) / E * 100;        // forward-return brut %
  const mfe = (hiMax - E) / E * 100;
  const mae = (loMin - E) / E * 100;
  if (verdict === 'NEUTRAL') verdict = fwd >= 0.2 ? 'WIN' : fwd <= -0.2 ? 'LOSE' : 'NEUTRAL';
  return { verdict, fwd, mfe, mae };
}

type Stat = { fwd: number[]; mfe: number[]; mae: number[]; win: number; lose: number; neu: number; n: number };
const newStat = (): Stat => ({ fwd: [], mfe: [], mae: [], win: 0, lose: 0, neu: 0, n: 0 });
function add(s: Stat, o: { verdict: string; fwd: number; mfe: number; mae: number }) {
  s.n++; s.fwd.push(o.fwd); s.mfe.push(o.mfe); s.mae.push(o.mae);
  if (o.verdict === 'WIN') s.win++; else if (o.verdict === 'LOSE') s.lose++; else s.neu++;
}
const med = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

(async () => {
  // 1) univers : candidats passed/opened, dédup 1er passage par symbole+jour
  const seen = new Set<string>();
  const cands: Array<{ symbol: string; market: string; T: number; mcap: number; cap_day: string }> = [];
  for (let d = 0; d < DAYS; d++) {
    const f = new Date(Date.now() - (d + 1) * 86400_000).toISOString();
    const t = new Date(Date.now() - d * 86400_000).toISOString();
    const { data } = await sb.from('top_gainers_log')
      .select('symbol,market,captured_at,market_cap_usd,decision')
      .in('market', MARKETS).in('decision', ['passed', 'opened'])
      .gte('captured_at', f).lt('captured_at', t)
      .order('captured_at', { ascending: true }).limit(1000);
    for (const r of (data ?? []) as any[]) {
      const day = r.captured_at.slice(0, 10);
      const k = r.symbol + '::' + day;
      if (seen.has(k)) continue; seen.add(k);
      cands.push({ symbol: r.symbol, market: r.market, T: new Date(r.captured_at).getTime(), mcap: +r.market_cap_usd || 0, cap_day: day });
    }
  }
  console.log(`Univers (passed/opened, dédup 1er passage/jour) sur ${DAYS}j : ${cands.length} signaux`);
  console.log(`MCAP_MIN liquide = $${(MCAP_MIN / 1e9).toFixed(1)}B · horizon ${HORIZON}min · TP+${TP}/SL-${SL}\n`);

  // 2) regroupe par symbole pour 1 seul fetch candles
  const bySym = new Map<string, typeof cands>();
  for (const c of cands) { (bySym.get(c.symbol) ?? bySym.set(c.symbol, []).get(c.symbol)!).push(c); }

  const arms: Record<string, Stat> = { baseline: newStat(), A: newStat(), B1: newStat(), B2: newStat(), A_B1: newStat() };
  const byMarketBase: Record<string, Stat> = {}; for (const m of MARKETS) byMarketBase[m] = newStat();
  let processed = 0, fillA = 0, tryA = 0, qualB2 = 0, tryB2 = 0, noCandle = 0;

  for (const [sym, list] of bySym) {
    const ts = list.map(c => c.T);
    const cs = await candles(sym, Math.floor((Math.min(...ts) - 86400_000) / 1000), Math.floor((Math.max(...ts) + (HORIZON + 90) * 60_000) / 1000));
    if (cs.length < 5) { noCandle++; continue; }
    for (const c of list) {
      const T = c.T;
      // bougie d'entrée baseline = 1ère bougie à ts >= T
      const entryIdx = cs.findIndex(x => x.ts >= T);
      if (entryIdx < 0) continue;
      const fwdWin = (eIdx: number) => cs.filter(x => x.ts > cs[eIdx].ts && x.ts <= cs[eIdx].ts + HORIZON * 60_000);

      // ---- baseline ----
      const postB = fwdWin(entryIdx);
      if (postB.length < 2) { noCandle++; continue; }
      const Eb = cs[entryIdx].close;
      const ob = simulate(postB, Eb);
      add(arms.baseline, ob); add(byMarketBase[c.market], ob); processed++;

      const liquid = c.mcap >= MCAP_MIN;

      // ---- B1 liquide ----
      if (liquid) add(arms.B1, ob);

      // ---- B2 liquide + soutenu (non-parabolique, multi-barres) ----
      if (liquid) {
        tryB2++;
        const pre = cs.filter(x => x.ts >= T - 30 * 60_000 && x.ts <= T);
        if (pre.length >= 4) {
          const slope = (pre[pre.length - 1].close - pre[0].close) / pre[0].close * 100;
          let maxBar = 0; for (let i = 1; i < pre.length; i++) maxBar = Math.max(maxBar, (pre[i].close - pre[i - 1].close) / pre[i - 1].close * 100);
          const preHigh = Math.max(...pre.map(p => p.high));
          const holding = Eb >= 0.98 * preHigh;
          // soutenu = pente +0.5..+8%, pas de barre verticale >4%, prix tient près du haut
          if (slope >= 0.5 && slope <= 8 && maxBar < 4 && holding) { qualB2++; add(arms.B2, ob); }
        }
      }

      // ---- A pullback (rouge -> verte) dans 30min ----
      tryA++;
      const win30 = cs.map((x, i) => ({ x, i })).filter(o => o.x.ts > T && o.x.ts <= T + 30 * 60_000);
      let entA = -1;
      for (let k = 1; k < win30.length; k++) {
        const prev = win30[k - 1].x, cur = win30[k].x;
        if (prev.close < cs[Math.max(0, win30[k - 1].i - 1)].close && cur.close > prev.close) { entA = win30[k].i; break; }
      }
      if (entA >= 0) {
        const postA = fwdWin(entA);
        if (postA.length >= 2) {
          fillA++;
          const oa = simulate(postA, cs[entA].close);
          add(arms.A, oa);
          if (liquid) add(arms.A_B1, oa);
        }
      }
    }
    await new Promise(r => setTimeout(r, 35));
  }

  const pr = (s: Stat) => {
    const dec = s.win + s.lose;
    const wr = dec > 0 ? (s.win / dec * 100) : NaN;
    const exp = s.n > 0 ? (s.win * TP - s.lose * SL) / s.n : NaN; // expectancy/trade en %
    return `n=${String(s.n).padStart(4)}  WR=${isNaN(wr) ? ' na' : wr.toFixed(0).padStart(3)}%  exp=${(exp >= 0 ? '+' : '') + exp.toFixed(3)}%  fwdMed=${(med(s.fwd) >= 0 ? '+' : '') + med(s.fwd).toFixed(3)}%  fwdMoy=${(mean(s.fwd) >= 0 ? '+' : '') + mean(s.fwd).toFixed(3)}%  MFEmed=${med(s.mfe).toFixed(2)}%  MAEmed=${med(s.mae).toFixed(2)}%`;
  };

  console.log(`\nProcessed=${processed}  symbols=${bySym.size}  noCandle=${noCandle}`);
  console.log(`fill A (pullback) = ${fillA}/${tryA} = ${(fillA / tryA * 100).toFixed(0)}%   qualif B2 = ${qualB2}/${tryB2} = ${(qualB2 / Math.max(1, tryB2) * 100).toFixed(0)}%\n`);
  console.log('=== ARMS (univers identique, outcome identique) ===');
  console.log('baseline  '.padEnd(12) + pr(arms.baseline));
  console.log('A pullback'.padEnd(12) + pr(arms.A));
  console.log('B1 liquide'.padEnd(12) + pr(arms.B1));
  console.log('B2 liq+sus'.padEnd(12) + pr(arms.B2));
  console.log('A∩B1     '.padEnd(12) + pr(arms.A_B1));
  console.log('\n=== baseline par marché ===');
  for (const m of MARKETS) console.log(m.padEnd(20) + pr(byMarketBase[m]));
})();
