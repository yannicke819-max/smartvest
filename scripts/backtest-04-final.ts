import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: opens } = await sb.from('lisa_positions')
    .select('symbol, realized_pnl_usd, status, venue_fee_detail, entry_timestamp, portfolio_id, entry_notional_usd')
    .gte('entry_timestamp','2026-06-04T00:00:00Z').lt('entry_timestamp','2026-06-05T00:00:00Z');
  const oversold = (opens ?? []).filter(p => ((p.venue_fee_detail as any)?.source ?? '').startsWith('scanner_oversold'));
  const uniqSyms = [...new Set(oversold.map(p => p.symbol))];
  
  // lookup via ticker
  const { data: assets } = await sb.from('assets').select('ticker, sector, asset_class').in('ticker', uniqSyms);
  const secMap = new Map((assets ?? []).map(a => [a.ticker, { sector: a.sector ?? '?', cls: a.asset_class }]));
  
  // miss = tickers non trouvés
  const missing = uniqSyms.filter(s => !secMap.has(s));
  console.log(`Tickers manquants dans assets: ${missing.length}/${uniqSyms.length}`);
  if (missing.length) console.log(`  Échantillon: ${missing.slice(0,15).join(', ')}`);
  
  console.log('\n=== Sector cap=2 simulation (rollback 04/06 — 48 positions HIGH oversold) ===');
  const sectorAgg: Record<string, {syms:string[]; pnl:number; w:number; l:number; pnls:number[]}> = {};
  for (const p of oversold) {
    const sec = secMap.get(p.symbol)?.sector ?? '?';
    sectorAgg[sec] = sectorAgg[sec] ?? {syms:[], pnl:0, w:0, l:0, pnls:[]};
    sectorAgg[sec].syms.push(p.symbol);
    const pnl = Number(p.realized_pnl_usd ?? 0);
    sectorAgg[sec].pnls.push(pnl);
    sectorAgg[sec].pnl += pnl;
    if (p.status !== 'open') {
      if (pnl > 0) sectorAgg[sec].w++; else sectorAgg[sec].l++;
    }
  }
  
  console.log(`${'Sector'.padEnd(28)} ${'cnt'.padEnd(4)} ${'W/L'.padEnd(7)} ${'PnL'.padEnd(9)} cap2_block`);
  let totalBlocked = 0;
  let blockedPnlSum = 0;
  for (const [s, info] of Object.entries(sectorAgg).sort((a,b)=>b[1].syms.length-a[1].syms.length)) {
    const block = Math.max(0, info.syms.length - 2);
    totalBlocked += block;
    // hypothèse pessimiste: gate bloque les 2 derniers par ordre entry (= ceux ouverts plus tard)
    // approx ici via pnl moyen
    if (block > 0) {
      const avg = info.pnl / info.syms.length;
      blockedPnlSum += avg * block;
    }
    console.log(`${s.padEnd(28)} ${String(info.syms.length).padEnd(4)} ${(info.w+'W/'+info.l+'L').padEnd(7)} $${info.pnl.toFixed(0).padStart(6)}   ${block}`);
  }
  const totalPnl = Object.values(sectorAgg).reduce((s,x)=>s+x.pnl,0);
  console.log(`\n  RÉEL : ${oversold.length} positions, PnL $${totalPnl.toFixed(2)}`);
  console.log(`  Avec cap=2 : ${oversold.length - totalBlocked} positions, PnL estimé $${(totalPnl - blockedPnlSum).toFixed(2)}`);
  
  // Si tout '?' -> backup: tente classification par asset_class + heuristique ticker
  const knownCount = Object.entries(sectorAgg).filter(([s]) => s !== '?').reduce((acc, [_,v]) => acc + v.syms.length, 0);
  console.log(`\n  Couverture sector valide: ${knownCount}/${oversold.length}`);
}
main().catch(console.error);
