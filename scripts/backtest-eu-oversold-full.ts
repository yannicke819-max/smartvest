import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const EODHD = '69e6325aa2c162.98850425';

interface Bar { date: string; close: number; volume: number }

async function fetchBars(sym: string): Promise<Bar[]> {
  try {
    const r = await fetch(`https://eodhd.com/api/eod/${sym}?from=2026-03-25&to=2026-06-04&api_token=${EODHD}&fmt=json`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const j = await r.json() as any[];
    if (!Array.isArray(j)) return [];
    return j
      .map(b => ({ date: String(b.date ?? ''), close: Number(b.close ?? NaN), volume: Number(b.volume ?? 0) }))
      .filter(b => b.date && Number.isFinite(b.close) && b.close > 0)
      .sort((a,b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

async function fetchMany(syms: string[], concurrency=10): Promise<Map<string, Bar[]>> {
  const res = new Map<string, Bar[]>();
  const queue = [...syms];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const s = queue.shift();
      if (!s) return;
      const b = await fetchBars(s);
      if (b.length > 10) res.set(s, b);
    }
  });
  await Promise.all(workers);
  return res;
}

async function main() {
  // 1. Univers stoxx600
  const { data: uni } = await sb.from('watchlist_universe').select('tickers').eq('name','stoxx600').maybeSingle();
  const tickers = (uni?.tickers as string[]) ?? [];
  console.log(`Tickers stoxx600: ${tickers.length}`);
  
  // 2. V2TX + SX5E pour computer le contexte régime à chaque date
  console.log('\nFetching V2TX + SX5E...');
  const v2tx = await fetchBars('V2TX.INDX');
  const sx5e = await fetchBars('SX5E.INDX');
  console.log(`V2TX ${v2tx.length} bars, SX5E ${sx5e.length} bars`);
  
  // Map date → V2TX level + V2TX chg 1d + SX5E 5d return
  const regimeByDate = new Map<string, {v2tx:number; v2txChg:number|null; sx5e5d:number|null}>();
  for (let i = 0; i < v2tx.length; i++) {
    const prev = i > 0 ? v2tx[i-1].close : null;
    const chg = prev ? (v2tx[i].close / prev - 1) * 100 : null;
    // Find SX5E 5d at this date
    const sx5eIdx = sx5e.findIndex(s => s.date === v2tx[i].date);
    const sx5e5d = sx5eIdx >= 5 ? (sx5e[sx5eIdx].close / sx5e[sx5eIdx-5].close - 1) * 100 : null;
    regimeByDate.set(v2tx[i].date, { v2tx: v2tx[i].close, v2txChg: chg, sx5e5d });
  }
  
  // 3. Fetch univers (518 tickers en parallèle)
  console.log(`\nFetching ${tickers.length} stoxx600 EOD bars (concurrency 10)...`);
  const t0 = Date.now();
  const bars = await fetchMany(tickers, 10);
  console.log(`Fetched ${bars.size}/${tickers.length} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  
  // 4. Simulation : pour chaque ticker, pour chaque jour J, si drop[-12,-5%] → enter, exit J+10
  type Trade = { ticker:string; entryDate:string; dropPct:number; pnlPct:number; v2tx:number|null; v2txChg:number|null; sx5e5d:number|null };
  const trades: Trade[] = [];
  for (const [sym, b] of bars.entries()) {
    for (let i = 1; i < b.length - 10; i++) {
      const dropPct = (b[i].close / b[i-1].close - 1) * 100;
      if (dropPct < -12 || dropPct > -5) continue;
      // liquidité
      if (b[i].close < 5 || b[i].close * b[i].volume < 1_000_000) continue;
      const exitIdx = Math.min(i + 10, b.length - 1);
      const pnlPct = (b[exitIdx].close / b[i].close - 1) * 100;
      const r = regimeByDate.get(b[i].date) ?? { v2tx: null, v2txChg: null, sx5e5d: null };
      trades.push({ ticker: sym, entryDate: b[i].date, dropPct, pnlPct, v2tx: r.v2tx as any, v2txChg: r.v2txChg, sx5e5d: r.sx5e5d });
    }
  }
  console.log(`\nTotal trades simulés: ${trades.length}`);
  
  const wins = trades.filter(t => t.pnlPct > 0).length;
  const totalPnl = trades.reduce((s,t) => s+t.pnlPct, 0);
  console.log(`Global : winRate=${(wins/trades.length*100).toFixed(1)}%  avgPnL=${(totalPnl/trades.length).toFixed(2)}%  sumPnL=${totalPnl.toFixed(1)}%`);
  
  // ─── Buckets V2TX ───
  console.log('\n=== Buckets V2TX level ===');
  const v2txBuckets = [
    { label:'< 20', filter: (t:Trade) => t.v2tx !== null && t.v2tx < 20 },
    { label:'20-22', filter: (t:Trade) => t.v2tx !== null && t.v2tx >= 20 && t.v2tx < 22 },
    { label:'22-24', filter: (t:Trade) => t.v2tx !== null && t.v2tx >= 22 && t.v2tx < 24 },
    { label:'24-26', filter: (t:Trade) => t.v2tx !== null && t.v2tx >= 24 && t.v2tx < 26 },
    { label:'>= 26', filter: (t:Trade) => t.v2tx !== null && t.v2tx >= 26 },
  ];
  for (const b of v2txBuckets) {
    const ts = trades.filter(b.filter);
    if (!ts.length) continue;
    const w = ts.filter(t => t.pnlPct > 0).length;
    const sum = ts.reduce((s,t)=>s+t.pnlPct,0);
    console.log(`  V2TX ${b.label.padEnd(8)}  n=${String(ts.length).padStart(4)}  winRate=${(w/ts.length*100).toFixed(1)}%  avgPnL=${(sum/ts.length).toFixed(2)}%  sumPnL=${sum.toFixed(1)}%`);
  }
  
  // ─── Buckets SX5E 5d ───
  console.log('\n=== Buckets SX5E 5d return ===');
  const sx5eBuckets = [
    { label:'< -2%', filter: (t:Trade) => t.sx5e5d !== null && t.sx5e5d < -2 },
    { label:'-2 to -1%', filter: (t:Trade) => t.sx5e5d !== null && t.sx5e5d >= -2 && t.sx5e5d < -1 },
    { label:'-1 to 0%', filter: (t:Trade) => t.sx5e5d !== null && t.sx5e5d >= -1 && t.sx5e5d < 0 },
    { label:'0 to 1%', filter: (t:Trade) => t.sx5e5d !== null && t.sx5e5d >= 0 && t.sx5e5d < 1 },
    { label:'>= 1%', filter: (t:Trade) => t.sx5e5d !== null && t.sx5e5d >= 1 },
  ];
  for (const b of sx5eBuckets) {
    const ts = trades.filter(b.filter);
    if (!ts.length) continue;
    const w = ts.filter(t => t.pnlPct > 0).length;
    const sum = ts.reduce((s,t)=>s+t.pnlPct,0);
    console.log(`  SX5E_5d ${b.label.padEnd(10)}  n=${String(ts.length).padStart(4)}  winRate=${(w/ts.length*100).toFixed(1)}%  avgPnL=${(sum/ts.length).toFixed(2)}%  sumPnL=${sum.toFixed(1)}%`);
  }
  
  // ─── Buckets ΔV2TX 1d ───
  console.log('\n=== Buckets ΔV2TX 1d ===');
  const dvBuckets = [
    { label:'< -5%', filter: (t:Trade) => t.v2txChg !== null && t.v2txChg < -5 },
    { label:'-5 to 0%', filter: (t:Trade) => t.v2txChg !== null && t.v2txChg >= -5 && t.v2txChg < 0 },
    { label:'0 to 5%', filter: (t:Trade) => t.v2txChg !== null && t.v2txChg >= 0 && t.v2txChg < 5 },
    { label:'5 to 10%', filter: (t:Trade) => t.v2txChg !== null && t.v2txChg >= 5 && t.v2txChg < 10 },
    { label:'>= 10%', filter: (t:Trade) => t.v2txChg !== null && t.v2txChg >= 10 },
  ];
  for (const b of dvBuckets) {
    const ts = trades.filter(b.filter);
    if (!ts.length) continue;
    const w = ts.filter(t => t.pnlPct > 0).length;
    const sum = ts.reduce((s,t)=>s+t.pnlPct,0);
    console.log(`  ΔV2TX ${b.label.padEnd(10)}  n=${String(ts.length).padStart(4)}  winRate=${(w/ts.length*100).toFixed(1)}%  avgPnL=${(sum/ts.length).toFixed(2)}%  sumPnL=${sum.toFixed(1)}%`);
  }
  
  // ─── Test "what-if" gates avec différents seuils ───
  console.log('\n=== Simulation gates (V2TX_MAX × SX5E_5D_MIN) ===');
  console.log('Format : gates → trades restants / total | winRate | avgPnL | sumPnL');
  const combos = [
    { vmax: 99, smin: -99, label: 'PAS_DE_GATE' },
    { vmax: 22, smin: -1.5, label: 'PR#620 défaut' },
    { vmax: 23, smin: -1.5, label: 'V2TX 23 SX5E -1.5' },
    { vmax: 24, smin: -1.5, label: 'V2TX 24 SX5E -1.5 (data-driven)' },
    { vmax: 24, smin: -2.0, label: 'V2TX 24 SX5E -2.0 (permissif)' },
    { vmax: 25, smin: -2.0, label: 'V2TX 25 SX5E -2.0 (très permissif)' },
  ];
  for (const c of combos) {
    const passed = trades.filter(t => (t.v2tx ?? 0) <= c.vmax && (t.sx5e5d ?? 0) >= c.smin);
    if (!passed.length) { console.log(`  ${c.label.padEnd(40)} 0/${trades.length} aucun trade`); continue; }
    const w = passed.filter(t => t.pnlPct > 0).length;
    const sum = passed.reduce((s,t)=>s+t.pnlPct,0);
    console.log(`  ${c.label.padEnd(40)} ${String(passed.length).padStart(4)}/${trades.length} | wr=${(w/passed.length*100).toFixed(1)}% | avg=${(sum/passed.length).toFixed(2)}% | sum=${sum.toFixed(1)}%`);
  }
}
main().catch(console.error);
