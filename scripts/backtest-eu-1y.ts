import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const EODHD = '69e6325aa2c162.98850425';

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

async function fetchBars(sym: string): Promise<Bar[]> {
  try {
    const r = await fetch(`https://eodhd.com/api/eod/${sym}?from=2025-05-01&to=2026-06-04&api_token=${EODHD}&fmt=json`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [];
    const j = await r.json() as any[];
    if (!Array.isArray(j)) return [];
    return j
      .map(b => ({
        date: String(b.date ?? ''),
        open: Number(b.open ?? NaN),
        high: Number(b.high ?? NaN),
        low: Number(b.low ?? NaN),
        close: Number(b.close ?? NaN),
        volume: Number(b.volume ?? 0),
      }))
      .filter(b => b.date && Number.isFinite(b.close) && b.close > 0 && Number.isFinite(b.low) && Number.isFinite(b.high))
      .sort((a,b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

async function fetchMany(syms: string[], concurrency=10): Promise<Map<string, Bar[]>> {
  const res = new Map<string, Bar[]>();
  const queue = [...syms];
  let done = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const s = queue.shift();
      if (!s) return;
      const b = await fetchBars(s);
      if (b.length > 30) res.set(s, b);
      done++;
      if (done % 50 === 0) process.stdout.write(`  ${done}/${syms.length}...`);
    }
  });
  await Promise.all(workers);
  console.log();
  return res;
}

async function main() {
  console.log('=== Backtest EU oversold 1 an (mai 2025 → juin 2026) avec SL -15% ===\n');
  
  const { data: uni } = await sb.from('watchlist_universe').select('tickers').eq('name','stoxx600').maybeSingle();
  const tickers = (uni?.tickers as string[]) ?? [];
  console.log(`Univers stoxx600: ${tickers.length} tickers`);
  
  console.log('\nFetching V2TX + SX5E (1 an)...');
  const v2tx = await fetchBars('V2TX.INDX');
  const sx5e = await fetchBars('SX5E.INDX');
  console.log(`V2TX ${v2tx.length} bars (${v2tx[0]?.date} → ${v2tx[v2tx.length-1]?.date})`);
  console.log(`SX5E ${sx5e.length} bars (${sx5e[0]?.date} → ${sx5e[sx5e.length-1]?.date})`);
  
  const regimeByDate = new Map<string, {v2tx:number; v2txChg:number|null; sx5e5d:number|null}>();
  for (let i = 0; i < v2tx.length; i++) {
    const prev = i > 0 ? v2tx[i-1].close : null;
    const chg = prev ? (v2tx[i].close / prev - 1) * 100 : null;
    const sx5eIdx = sx5e.findIndex(s => s.date === v2tx[i].date);
    const sx5e5d = sx5eIdx >= 5 ? (sx5e[sx5eIdx].close / sx5e[sx5eIdx-5].close - 1) * 100 : null;
    regimeByDate.set(v2tx[i].date, { v2tx: v2tx[i].close, v2txChg: chg, sx5e5d });
  }
  
  console.log(`\nFetching ${tickers.length} stoxx600 EOD bars 1 an (concurrency 10)...`);
  const t0 = Date.now();
  const bars = await fetchMany(tickers, 10);
  console.log(`Fetched ${bars.size}/${tickers.length} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  
  // SIM avec SL catastrophe -15% modélisé
  const SL_CATA = -15;  // %
  const HOLD = 10;       // jours ouvrés
  type Trade = {
    ticker: string; entryDate: string; dropPct: number;
    pnlPct: number; exitReason: 'tp'|'sl'|'hold_end';
    holdDays: number;
    v2tx: number|null; v2txChg: number|null; sx5e5d: number|null;
  };
  const trades: Trade[] = [];
  
  for (const [sym, b] of bars.entries()) {
    for (let i = 1; i < b.length - 1; i++) {
      const dropPct = (b[i].close / b[i-1].close - 1) * 100;
      if (dropPct < -12 || dropPct > -5) continue;
      // liquidité
      if (b[i].close < 5 || b[i].close * b[i].volume < 1_000_000) continue;
      
      const entryPx = b[i].close;
      const slPx = entryPx * (1 + SL_CATA / 100);
      
      // Walk forward J+10 ou SL hit (low <= slPx)
      let exitIdx = Math.min(i + HOLD, b.length - 1);
      let exitPx = b[exitIdx].close;
      let exitReason: 'tp'|'sl'|'hold_end' = 'hold_end';
      let holdDays = HOLD;
      
      for (let k = 1; k <= HOLD && i + k < b.length; k++) {
        const day = b[i + k];
        if (day.low <= slPx) {
          // SL touché ce jour-là
          exitPx = slPx;
          exitIdx = i + k;
          exitReason = 'sl';
          holdDays = k;
          break;
        }
      }
      
      const pnlPct = (exitPx / entryPx - 1) * 100;
      const r = regimeByDate.get(b[i].date) ?? { v2tx: null, v2txChg: null, sx5e5d: null };
      trades.push({
        ticker: sym, entryDate: b[i].date, dropPct, pnlPct, exitReason, holdDays,
        v2tx: r.v2tx, v2txChg: r.v2txChg, sx5e5d: r.sx5e5d,
      });
    }
  }
  console.log(`\nTotal trades simulés: ${trades.length}`);
  
  const wins = trades.filter(t => t.pnlPct > 0).length;
  const totalPnl = trades.reduce((s,t) => s+t.pnlPct, 0);
  const slHits = trades.filter(t => t.exitReason === 'sl').length;
  console.log(`Global : winRate=${(wins/trades.length*100).toFixed(1)}%  avgPnL=${(totalPnl/trades.length).toFixed(2)}%  sumPnL=${totalPnl.toFixed(0)}%  SL_hits=${slHits} (${(slHits/trades.length*100).toFixed(1)}%)`);
  
  // distribution V2TX
  const v2txVals = trades.map(t => t.v2tx).filter((x): x is number => x !== null).sort((a,b)=>a-b);
  if (v2txVals.length > 0) {
    const pct = (arr: number[], p: number) => arr[Math.floor(arr.length*p)];
    console.log(`V2TX trades : min=${v2txVals[0].toFixed(1)} p25=${pct(v2txVals,0.25).toFixed(1)} med=${pct(v2txVals,0.5).toFixed(1)} p75=${pct(v2txVals,0.75).toFixed(1)} p90=${pct(v2txVals,0.9).toFixed(1)} max=${v2txVals[v2txVals.length-1].toFixed(1)}`);
  }
  
  console.log('\n=== Buckets V2TX level (avec SL -15% modélisé) ===');
  const vbuckets = [
    { l:'< 15',  f:(t:Trade)=>t.v2tx!==null && t.v2tx<15 },
    { l:'15-18', f:(t:Trade)=>t.v2tx!==null && t.v2tx>=15 && t.v2tx<18 },
    { l:'18-20', f:(t:Trade)=>t.v2tx!==null && t.v2tx>=18 && t.v2tx<20 },
    { l:'20-22', f:(t:Trade)=>t.v2tx!==null && t.v2tx>=20 && t.v2tx<22 },
    { l:'22-25', f:(t:Trade)=>t.v2tx!==null && t.v2tx>=22 && t.v2tx<25 },
    { l:'25-30', f:(t:Trade)=>t.v2tx!==null && t.v2tx>=25 && t.v2tx<30 },
    { l:'>= 30', f:(t:Trade)=>t.v2tx!==null && t.v2tx>=30 },
  ];
  for (const b of vbuckets) {
    const ts = trades.filter(b.f);
    if (!ts.length) continue;
    const w = ts.filter(t => t.pnlPct > 0).length;
    const sum = ts.reduce((s,t)=>s+t.pnlPct,0);
    const sl = ts.filter(t => t.exitReason === 'sl').length;
    console.log(`  V2TX ${b.l.padEnd(7)}  n=${String(ts.length).padStart(4)}  wr=${(w/ts.length*100).toFixed(1)}%  avg=${(sum/ts.length).toFixed(2)}%  sum=${sum.toFixed(0)}%  SL=${(sl/ts.length*100).toFixed(0)}%`);
  }
  
  console.log('\n=== Gates simulation (1 an avec SL) ===');
  const combos = [
    { vmax: 99, smin: -99, dmax: 99, label: 'PAS_DE_GATE' },
    { vmax: 22, smin: -1.5, dmax: 10, label: 'PR #620 défaut' },
    { vmax: 24, smin: -1.5, dmax: 10, label: 'V24/SX-1.5/d10' },
    { vmax: 25, smin: -2.0, dmax: 8, label: 'V25/SX-2.0/d8' },
    { vmax: 26, smin: -2.5, dmax: 8, label: 'V26/SX-2.5/d8 (prudent)' },
    { vmax: 28, smin: -3.0, dmax: 10, label: 'V28/SX-3.0/d10 (très permissif)' },
    { vmax: 30, smin: -99, dmax: 99, label: 'V30 only (extrême panique)' },
  ];
  for (const c of combos) {
    const passed = trades.filter(t => (t.v2tx??0)<=c.vmax && (t.sx5e5d??0)>=c.smin && (t.v2txChg??0)<=c.dmax);
    if (!passed.length) { console.log(`  ${c.label.padEnd(40)} 0/${trades.length}`); continue; }
    const w = passed.filter(t => t.pnlPct > 0).length;
    const sum = passed.reduce((s,t)=>s+t.pnlPct,0);
    const sl = passed.filter(t => t.exitReason === 'sl').length;
    console.log(`  ${c.label.padEnd(40)} ${String(passed.length).padStart(4)}/${trades.length} | wr=${(w/passed.length*100).toFixed(1)}% | avg=${(sum/passed.length).toFixed(2)}% | sum=${sum.toFixed(0)}% | SL=${(sl/passed.length*100).toFixed(0)}%`);
  }
}
main().catch(console.error);
