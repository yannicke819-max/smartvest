import 'dotenv/config';
const EODHD = '69e6325aa2c162.98850425';

async function eod(sym: string, from: string, to: string) {
  const r = await fetch(`https://eodhd.com/api/eod/${sym}?from=${from}&to=${to}&api_token=${EODHD}&fmt=json`);
  if (!r.ok) { console.log(`  ${sym} HTTP ${r.status}`); return null; }
  return await r.json() as any[];
}

async function main() {
  console.log('=== Backtest EU regime — V2TX + SX5E historique 60j ===\n');
  
  const v2tx = await eod('V2TX.INDX','2026-04-01','2026-06-04');
  const sx5e = await eod('SX5E.INDX','2026-04-01','2026-06-04');
  if (!v2tx || !sx5e) { console.log('failed to fetch'); return; }
  
  console.log(`V2TX bars: ${v2tx.length}, range ${v2tx[0]?.date} → ${v2tx[v2tx.length-1]?.date}`);
  console.log(`SX5E bars: ${sx5e.length}, range ${sx5e[0]?.date} → ${sx5e[sx5e.length-1]?.date}`);
  
  // distribution V2TX
  const vix = v2tx.map(d => d.close).sort((a,b) => a-b);
  const pct = (arr: number[], p: number) => arr[Math.floor(arr.length*p)];
  console.log(`\nV2TX distribution 60j:`);
  console.log(`  min=${vix[0].toFixed(2)}  p25=${pct(vix,0.25).toFixed(2)}  median=${pct(vix,0.5).toFixed(2)}  p75=${pct(vix,0.75).toFixed(2)}  p90=${pct(vix,0.9).toFixed(2)}  max=${vix[vix.length-1].toFixed(2)}`);
  
  // SX5E 5d returns
  const sx5eSorted = sx5e.sort((a,b)=>a.date.localeCompare(b.date));
  const r5d: {date:string; r5:number}[] = [];
  for (let i = 5; i < sx5eSorted.length; i++) {
    const r = (sx5eSorted[i].close / sx5eSorted[i-5].close - 1) * 100;
    r5d.push({ date: sx5eSorted[i].date, r5: r });
  }
  const rs = r5d.map(x=>x.r5).sort((a,b)=>a-b);
  console.log(`\nSX5E 5d return distribution 55j:`);
  console.log(`  min=${rs[0].toFixed(2)}%  p10=${pct(rs,0.1).toFixed(2)}%  p25=${pct(rs,0.25).toFixed(2)}%  median=${pct(rs,0.5).toFixed(2)}%  p75=${pct(rs,0.75).toFixed(2)}%  p90=${pct(rs,0.9).toFixed(2)}%  max=${rs[rs.length-1].toFixed(2)}%`);
  
  // V2TX 1d delta
  const v2txSorted = v2tx.sort((a,b)=>a.date.localeCompare(b.date));
  const v2txChg: {date:string; chg:number; close:number}[] = [];
  for (let i = 1; i < v2txSorted.length; i++) {
    const chg = (v2txSorted[i].close / v2txSorted[i-1].close - 1) * 100;
    v2txChg.push({ date: v2txSorted[i].date, chg, close: v2txSorted[i].close });
  }
  const chgs = v2txChg.map(x=>x.chg).sort((a,b)=>a-b);
  console.log(`\nΔV2TX 1d distribution:`);
  console.log(`  min=${chgs[0].toFixed(1)}%  p10=${pct(chgs,0.1).toFixed(1)}%  median=${pct(chgs,0.5).toFixed(1)}%  p90=${pct(chgs,0.9).toFixed(1)}%  max=${chgs[chgs.length-1].toFixed(1)}%`);
  
  // identifier journées de stress
  console.log(`\n=== Top 10 jours de stress EU (V2TX > seuils) ===`);
  const stressDays = v2txChg
    .map(x => ({...x, r5: r5d.find(y => y.date === x.date)?.r5 ?? null}))
    .filter(x => x.close > 20 || x.chg > 15 || (x.r5 !== null && x.r5 < -2))
    .sort((a,b) => b.close - a.close);
  for (const d of stressDays.slice(0,15)) {
    console.log(`  ${d.date}  V2TX=${d.close.toFixed(2)}  Δ1d=${d.chg.toFixed(1)}%  SX5E_5d=${d.r5?.toFixed(2) ?? '?'}%`);
  }
  
  // Suggestion seuils data-driven : p75/p90 V2TX, p10 SX5E 5d
  console.log(`\n=== Recommandation calibration EU data-driven (60j) ===`);
  const v2txP75 = pct(vix, 0.75);
  const v2txP85 = pct(vix, 0.85);
  const v2txP90 = pct(vix, 0.9);
  const r5p10 = pct(rs, 0.1);
  const r5p15 = pct(rs, 0.15);
  console.log(`Si on cible "bloquer 10-15% des pires régimes" :`);
  console.log(`  V2TX_MAX = ${v2txP85.toFixed(1)} (p85) ou ${v2txP90.toFixed(1)} (p90)  [actuel défaut 22]`);
  console.log(`  SX5E_5D_MIN = ${r5p10.toFixed(2)}% (p10) ou ${r5p15.toFixed(2)}% (p15)  [actuel défaut -1.5%]`);
  const chgP90 = pct(chgs, 0.9);
  console.log(`  V2TX_DELTA_MAX = ${chgP90.toFixed(1)}% (p90)  [actuel défaut 10%]`);
}
main().catch(console.error);
