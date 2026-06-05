import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const EODHD = '69e6325aa2c162.98850425';

async function eod(sym: string, from: string, to: string) {
  const r = await fetch(`https://eodhd.com/api/eod/${sym}?from=${from}&to=${to}&api_token=${EODHD}&fmt=json`);
  if (!r.ok) return null;
  return await r.json() as any[];
}
async function fundamental(sym: string): Promise<{sector?:string;industry?:string;gic?:string}|null> {
  try {
    const r = await fetch(`https://eodhd.com/api/fundamentals/${sym}?api_token=${EODHD}&fmt=json`);
    if (!r.ok) return null;
    const j: any = await r.json();
    return { sector: j?.General?.Sector, industry: j?.General?.Industry, gic: j?.General?.GicSector };
  } catch { return null; }
}

async function main() {
  console.log('=== VIX 03-05/06 ===');
  const vix = await eod('VIX.INDX','2026-06-01','2026-06-05');
  for (const d of vix ?? []) console.log(`  ${d.date}  close=${d.close}  high=${d.high}`);
  
  console.log('\n=== SPY 5d return (04/06 vs 05/06) ===');
  const spy = await eod('SPY.US','2026-05-25','2026-06-05');
  if (spy) {
    const sorted = spy.sort((a,b)=>a.date.localeCompare(b.date));
    const d0406 = sorted.findIndex(d=>d.date==='2026-06-04');
    const d0506 = sorted.findIndex(d=>d.date==='2026-06-05');
    if (d0406 >= 5) {
      const r5_04 = (sorted[d0406].close / sorted[d0406-5].close - 1) * 100;
      console.log(`  04/06 5d return (close ${sorted[d0406].close} vs ${sorted[d0406-5].date} ${sorted[d0406-5].close}) = ${r5_04.toFixed(2)}%`);
    }
    if (d0506 >= 5) {
      const r5_05 = (sorted[d0506].close / sorted[d0506-5].close - 1) * 100;
      console.log(`  05/06 5d return (close ${sorted[d0506].close} vs ${sorted[d0506-5].date} ${sorted[d0506-5].close}) = ${r5_05.toFixed(2)}%`);
    }
  }
  
  console.log('\n=== Sectors via fundamentals (29 tickers HIGH oversold 04/06) ===');
  const { data: opens } = await sb.from('lisa_positions')
    .select('symbol, realized_pnl_usd, status, venue_fee_detail')
    .gte('entry_timestamp','2026-06-04T00:00:00Z').lt('entry_timestamp','2026-06-05T00:00:00Z');
  const oversold = (opens ?? []).filter(p => ((p.venue_fee_detail as any)?.source ?? '').startsWith('scanner_oversold'));
  const uniq = [...new Set(oversold.map(p => p.symbol))];
  console.log(`Tickers uniques: ${uniq.length}`);
  
  const secMap = new Map<string,string>();
  await Promise.all(uniq.map(async s => {
    const f = await fundamental(s);
    secMap.set(s, f?.sector ?? f?.gic ?? '?');
  }));
  
  const agg: Record<string,{syms:string[];pnl:number;w:number;l:number}> = {};
  for (const p of oversold) {
    const sec = secMap.get(p.symbol) ?? '?';
    agg[sec] = agg[sec] ?? {syms:[],pnl:0,w:0,l:0};
    agg[sec].syms.push(p.symbol);
    const pnl = Number(p.realized_pnl_usd ?? 0);
    agg[sec].pnl += pnl;
    if (p.status !== 'open') { if (pnl > 0) agg[sec].w++; else agg[sec].l++; }
  }
  console.log(`${'Sector'.padEnd(28)} ${'cnt'.padEnd(4)} ${'W/L'.padEnd(7)} ${'PnL'.padEnd(10)} cap2_block`);
  let totalBlocked = 0; let blockedPnl = 0;
  for (const [s, info] of Object.entries(agg).sort((a,b)=>b[1].syms.length-a[1].syms.length)) {
    const block = Math.max(0, info.syms.length - 2);
    totalBlocked += block;
    const avg = info.pnl / info.syms.length;
    blockedPnl += avg * block;
    console.log(`${s.padEnd(28)} ${String(info.syms.length).padEnd(4)} ${(info.w+'W/'+info.l+'L').padEnd(7)} $${info.pnl.toFixed(0).padStart(7)}    ${block}`);
  }
  const totalPnl = Object.values(agg).reduce((s,x)=>s+x.pnl,0);
  console.log(`\n  RÉEL : ${oversold.length} positions, PnL $${totalPnl.toFixed(2)}`);
  console.log(`  Cap=2 bloquerait ${totalBlocked}/${oversold.length} → PnL estimé $${(totalPnl - blockedPnl).toFixed(2)} (raté: $${blockedPnl.toFixed(2)})`);
  
  // Sectors 05/06 pour comparaison
  console.log('\n=== Comparaison sectors 05/06 oversold HIGH (11 positions) ===');
  const { data: opens5 } = await sb.from('lisa_positions')
    .select('symbol, status, realized_pnl_usd, venue_fee_detail, entry_notional_usd, entry_price')
    .gte('entry_timestamp','2026-06-05T00:00:00Z').eq('portfolio_id','a0000001-0000-0000-0000-000000000001');
  const ov5 = (opens5 ?? []).filter(p => ((p.venue_fee_detail as any)?.source ?? '').startsWith('scanner_oversold'));
  console.log(`Total oversold 05/06 = ${ov5.length}`);
  const uniq5 = [...new Set(ov5.map(p => p.symbol))];
  await Promise.all(uniq5.filter(s=>!secMap.has(s)).map(async s => {
    const f = await fundamental(s);
    secMap.set(s, f?.sector ?? '?');
  }));
  const agg5: Record<string,{syms:string[]}> = {};
  for (const p of ov5) {
    const sec = secMap.get(p.symbol) ?? '?';
    agg5[sec] = agg5[sec] ?? {syms:[]};
    agg5[sec].syms.push(p.symbol);
  }
  for (const [s, info] of Object.entries(agg5).sort((a,b)=>b[1].syms.length-a[1].syms.length)) {
    console.log(`  ${s.padEnd(28)} ${info.syms.length}  (${info.syms.join(', ')})`);
  }
}
main().catch(console.error);
