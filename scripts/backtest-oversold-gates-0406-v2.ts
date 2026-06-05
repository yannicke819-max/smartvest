import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const EODHD = process.env.EODHD_API_KEY!;

async function fetchEodPrice(sym: string) {
  const url = `https://eodhd.com/api/eod/${sym}?from=2026-05-25&to=2026-06-04&api_token=${EODHD}&fmt=json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) { console.log(`  ${sym} HTTP ${r.status}`); return null; }
    return await r.json() as any[];
  } catch (e) { console.log(`  ${sym} err: ${String(e).slice(0,60)}`); return null; }
}

async function fetchFundamentals(sym: string) {
  const url = `https://eodhd.com/api/fundamentals/${sym}?api_token=${EODHD}&fmt=json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    return j?.General?.Sector ?? j?.General?.GicSector ?? null;
  } catch { return null; }
}

async function main() {
  // ---------- GATE 1 : VIX 04/06 ----------
  console.log('=== GATE 1 : VIX 04/06 ===');
  const vxx = await fetchEodPrice('VXX.US');
  if (vxx) {
    const sorted = vxx.sort((a:any,b:any)=>a.date.localeCompare(b.date));
    const d0406 = sorted.find((d:any)=>d.date==='2026-06-04');
    const d0306 = sorted.find((d:any)=>d.date==='2026-06-03');
    console.log(`  VXX 03/06=${d0306?.close} 04/06=${d0406?.close}`);
    if (d0306 && d0406) {
      const chg = (d0406.close/d0306.close - 1) * 100;
      console.log(`  Δ1d = ${chg.toFixed(1)}%`);
      // proxy : VXX ≈ VIX/2 environ
      console.log(`  → VIX (estimé ≈ VXX×0.85 + offset) → fenêtre proxy uniquement`);
    }
  }

  // ---------- GATE 2 : SPY 5d return ----------
  console.log('\n=== GATE 2 : SPY 5d return ===');
  const spy = await fetchEodPrice('SPY.US');
  if (spy) {
    const sorted = spy.sort((a:any,b:any)=>a.date.localeCompare(b.date));
    const last = sorted[sorted.length-1];
    const fiveBefore = sorted[sorted.length-6];
    console.log(`  SPY ${fiveBefore?.date}=${fiveBefore?.close} → ${last?.date}=${last?.close}`);
    if (last && fiveBefore) {
      const r5 = (last.close/fiveBefore.close - 1) * 100;
      console.log(`  5d return = ${r5.toFixed(2)}%`);
      console.log(`  → bloque si < -3% : ${r5 < -3 ? 'OUI' : 'NON'}`);
    }
  }
  
  // ---------- GATE 3 : Sector — fetch via fundamentals EODHD ----------
  console.log('\n=== GATE 3 : Sector breakdown 04/06 oversold ===');
  const { data: opens } = await sb.from('lisa_positions')
    .select('symbol, realized_pnl_usd, status, venue_fee_detail, entry_timestamp')
    .gte('entry_timestamp','2026-06-04T00:00:00Z').lt('entry_timestamp','2026-06-05T00:00:00Z');
  const oversold = (opens ?? []).filter(p => ((p.venue_fee_detail as any)?.source ?? '').startsWith('scanner_oversold'));
  
  const cache: Record<string,string> = {};
  for (const p of oversold) {
    if (!cache[p.symbol]) {
      const sec = await fetchFundamentals(p.symbol);
      cache[p.symbol] = sec ?? '?';
    }
  }
  const sectorMap: Record<string,{syms:string[];pnl:number;w:number;l:number}> = {};
  for (const p of oversold) {
    const sec = cache[p.symbol] ?? '?';
    sectorMap[sec] = sectorMap[sec] ?? {syms:[], pnl:0, w:0, l:0};
    sectorMap[sec].syms.push(p.symbol);
    const pnl = Number(p.realized_pnl_usd ?? 0);
    sectorMap[sec].pnl += pnl;
    if (p.status !== 'open') { if (pnl > 0) sectorMap[sec].w++; else sectorMap[sec].l++; }
  }
  console.log(`Total oversold 04/06 = ${oversold.length} positions\n`);
  console.log(`${'Sector'.padEnd(28)} ${'cnt'.padEnd(4)} ${'W/L'.padEnd(7)} ${'PnL'.padEnd(10)} blocked-by-cap2`);
  let totalBlocked = 0, blockedPnl = 0;
  for (const [s, info] of Object.entries(sectorMap).sort((a,b)=>b[1].syms.length-a[1].syms.length)) {
    const block = Math.max(0, info.syms.length - 2);
    totalBlocked += block;
    if (block > 0) {
      const avgPnl = info.pnl / info.syms.length;
      blockedPnl += avgPnl * block;
    }
    console.log(`${s.padEnd(28)} ${String(info.syms.length).padEnd(4)} ${(info.w+'W/'+info.l+'L').padEnd(7)} $${info.pnl.toFixed(0).padStart(7)}   ${block}`);
  }
  const totalPnl = Object.values(sectorMap).reduce((s,x)=>s+x.pnl,0);
  console.log(`\n  → Sector cap=2 bloquerait ${totalBlocked}/${oversold.length} positions`);
  console.log(`  PnL réalisé total RÉEL : $${totalPnl.toFixed(2)}`);
  console.log(`  PnL des bloqués (proxy avg/sector) : ${blockedPnl >= 0 ? '+' : ''}$${blockedPnl.toFixed(2)}`);
  console.log(`  PnL "préservé" si gate actif : $${(totalPnl - blockedPnl).toFixed(2)}`);
}
main().catch(console.error);
