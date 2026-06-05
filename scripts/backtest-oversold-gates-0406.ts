import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const EODHD = process.env.EODHD_API_KEY!;

async function fetchEodPrice(sym: string, days: number) {
  const to = '2026-06-04';
  const fromDate = new Date(Date.UTC(2026, 5, 4) - (days+5)*86400000).toISOString().slice(0,10);
  const url = `https://eodhd.com/api/eod/${sym}?from=${fromDate}&to=${to}&api_token=${EODHD}&fmt=json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    return j;
  } catch { return null; }
}

async function main() {
  // toutes les positions OUVERTES le 04/06 (entry_timestamp 04/06)
  const { data: opens } = await sb.from('lisa_positions')
    .select('symbol, asset_class, entry_timestamp, exit_timestamp, status, realized_pnl_usd, entry_price, entry_notional_usd, venue_fee_detail, portfolio_id')
    .gte('entry_timestamp','2026-06-04T00:00:00Z').lt('entry_timestamp','2026-06-05T00:00:00Z')
    .order('entry_timestamp', { ascending: true });
  
  console.log(`\nPositions ouvertes 04/06 : ${opens?.length ?? 0}\n`);
  
  // filtre = source oversold (le scanner cible exclu)
  const oversoldOnly = (opens ?? []).filter(p => {
    const src = (p.venue_fee_detail as any)?.source ?? '';
    return src === 'scanner_oversold' || src === 'scanner_oversold_intraday' || src === 'scanner_oversold_overnight';
  });
  console.log(`Dont sources oversold : ${oversoldOnly.length}`);
  console.log(`(les autres = scanner gainers TRADER, hors scope du gate test)\n`);
  
  // ---------- GATE 1 : VIX ----------
  const vixData = await fetchEodPrice('VXX.US', 10) ?? await fetchEodPrice('VIX.INDX', 10);
  if (vixData && Array.isArray(vixData)) {
    const vix0306 = vixData.find((d:any) => d.date === '2026-06-03');
    const vix0406 = vixData.find((d:any) => d.date === '2026-06-04');
    console.log(`GATE 1 VIX : 03/06=${vix0306?.close} 04/06=${vix0406?.close}`);
    if (vix0306 && vix0406) {
      const chg = (vix0406.close / vix0306.close - 1) * 100;
      const blockedByLevel = vix0406.close > 25;
      const blockedBySpike = chg > 30;
      console.log(`  chg 1d = ${chg.toFixed(1)}% | block 25 = ${blockedByLevel} | block +30%spike = ${blockedBySpike}\n`);
    }
  }
  
  // ---------- GATE 2 : SPY 5d ----------
  const spyData = await fetchEodPrice('SPY.US', 10);
  if (spyData && Array.isArray(spyData)) {
    const sorted = spyData.sort((a:any,b:any)=>a.date.localeCompare(b.date));
    const day4 = sorted[sorted.length-1];
    const day5b = sorted[sorted.length-6];
    if (day4 && day5b) {
      const r5 = (day4.close / day5b.close - 1) * 100;
      console.log(`GATE 2 SPY : 5d return ${r5.toFixed(2)}%`);
      console.log(`  bloque (< -3%) = ${r5 < -3}\n`);
    }
  }
  
  // ---------- GATE 3 : Sector cap ----------
  const sectorCounts: Record<string, string[]> = {};
  for (const p of oversoldOnly) {
    const { data: a } = await sb.from('assets').select('sector').eq('symbol', p.symbol).maybeSingle();
    const sec = a?.sector ?? '?';
    sectorCounts[sec] = sectorCounts[sec] ?? [];
    sectorCounts[sec].push(p.symbol);
  }
  console.log(`GATE 3 Sector breakdown :`);
  for (const [s, syms] of Object.entries(sectorCounts).sort((a,b)=>b[1].length-a[1].length)) {
    console.log(`  ${s.padEnd(28)} ${syms.length}  (${syms.slice(0,4).join(', ')}${syms.length>4?'...':''})`);
  }
  const wouldSkip = Object.values(sectorCounts).reduce((acc, syms) => acc + Math.max(0, syms.length - 2), 0);
  console.log(`  → bloquerait ${wouldSkip}/${oversoldOnly.length} positions (cap=2)\n`);
  
  // ---------- Outcome réel ----------
  const closed = oversoldOnly.filter(p => p.status !== 'open');
  const wins = closed.filter(p => Number(p.realized_pnl_usd) > 0).length;
  const losses = closed.length - wins;
  const totalPnl = closed.reduce((s,p)=>s+Number(p.realized_pnl_usd ?? 0), 0);
  console.log(`OUTCOME RÉEL des ${oversoldOnly.length} oversold 04/06 :`);
  console.log(`  Fermées : ${closed.length} (W=${wins} L=${losses})`);
  console.log(`  Encore open : ${oversoldOnly.length - closed.length}`);
  console.log(`  PnL réalisé total : $${totalPnl.toFixed(2)}`);
}
main().catch(console.error);
