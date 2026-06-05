import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // dump asset columns
  const { data: oneAsset } = await sb.from('assets').select('*').limit(1);
  console.log('assets cols:', Object.keys(oneAsset?.[0] ?? {}));

  const { data: opens } = await sb.from('lisa_positions')
    .select('symbol, realized_pnl_usd, status, venue_fee_detail, entry_timestamp, portfolio_id')
    .gte('entry_timestamp','2026-06-04T00:00:00Z').lt('entry_timestamp','2026-06-05T00:00:00Z');
  const oversold = (opens ?? []).filter(p => ((p.venue_fee_detail as any)?.source ?? '').startsWith('scanner_oversold'));
  console.log(`\nTotal oversold 04/06 = ${oversold.length}\n`);
  
  const uniqSyms = [...new Set(oversold.map(p => p.symbol))];
  const { data: assets } = await sb.from('assets').select('symbol, sector, industry').in('symbol', uniqSyms);
  const secMap = new Map((assets ?? []).map(a => [a.symbol, a.sector ?? '?']));
  
  const sectorAgg: Record<string, {syms:string[]; pnl:number; w:number; l:number}> = {};
  for (const p of oversold) {
    const sec = secMap.get(p.symbol) ?? '?';
    sectorAgg[sec] = sectorAgg[sec] ?? {syms:[], pnl:0, w:0, l:0};
    sectorAgg[sec].syms.push(p.symbol);
    const pnl = Number(p.realized_pnl_usd ?? 0);
    sectorAgg[sec].pnl += pnl;
    if (p.status !== 'open') {
      if (pnl > 0) sectorAgg[sec].w++; else sectorAgg[sec].l++;
    }
  }
  
  console.log(`${'Sector'.padEnd(28)} ${'cnt'.padEnd(4)} ${'W/L'.padEnd(7)} ${'PnL'.padEnd(9)} cap2_block  blocked_avg_pnl`);
  let totalBlocked = 0, blockedPnlEst = 0;
  for (const [s, info] of Object.entries(sectorAgg).sort((a,b)=>b[1].syms.length-a[1].syms.length)) {
    const block = Math.max(0, info.syms.length - 2);
    totalBlocked += block;
    const avgPnl = info.pnl / info.syms.length;
    const blockedPnl = avgPnl * block;
    blockedPnlEst += blockedPnl;
    console.log(`${s.padEnd(28)} ${String(info.syms.length).padEnd(4)} ${(info.w+'W/'+info.l+'L').padEnd(7)} $${info.pnl.toFixed(0).padStart(6)}   ${String(block).padStart(2)}          $${blockedPnl.toFixed(0).padStart(6)}`);
  }
  const totalPnl = Object.values(sectorAgg).reduce((s,x)=>s+x.pnl,0);
  console.log(`\nRÉEL : ${oversold.length} positions, PnL réalisé $${totalPnl.toFixed(2)}`);
  console.log(`Sector cap=2 bloquerait ${totalBlocked}/${oversold.length} positions`);
  console.log(`PnL "raté" (proxy avg) : $${blockedPnlEst.toFixed(2)}`);
  console.log(`PnL si gate actif : $${(totalPnl - blockedPnlEst).toFixed(2)}`);

  // par portfolio
  console.log('\n=== Par portfolio ===');
  const pfAgg: Record<string,{n:number;pnl:number}> = {};
  for (const p of oversold) {
    const pf = (p.portfolio_id ?? '').slice(0,12);
    pfAgg[pf] = pfAgg[pf] ?? {n:0,pnl:0};
    pfAgg[pf].n++;
    pfAgg[pf].pnl += Number(p.realized_pnl_usd ?? 0);
  }
  for (const [pf,a] of Object.entries(pfAgg)) console.log(`  ${pf}... n=${a.n} pnl=$${a.pnl.toFixed(2)}`);
}
main().catch(console.error);
