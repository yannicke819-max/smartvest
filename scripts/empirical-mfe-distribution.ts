import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PORT: Record<string, string> = {
  'b0000001-0000-0000-0000-000000000001': 'TRADER',
  'a0000001-0000-0000-0000-000000000001': 'HIGH',
  'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
  'a0000003-0000-0000-0000-000000000003': 'SMALL',
};

async function main() {
  // Tous trades fermés des 4 portfolios + ceux historiques (avec ancien UUID éventuel)
  const { data: trades } = await sb
    .from('lisa_positions')
    .select('symbol, asset_class, portfolio_id, entry_price, exit_price, peak_pre_exit, stop_loss_price, take_profit_price, direction, realized_pnl_usd, exit_reason, entry_timestamp, exit_timestamp')
    .neq('status', 'open')
    .order('entry_timestamp', { ascending: false });

  if (!trades || trades.length === 0) { console.log('Pas de data'); return; }

  // Per-trade analytics
  type Row = {
    sym: string; class: string; port: string;
    mfePct: number; realPct: number; capturePct: number;
    slPct: number; tpPct: number;
    exitReason: string; durationMin: number;
    wouldHitTPIfNoChoppy: boolean;
  };

  const enriched: Row[] = [];
  for (const t of trades) {
    const isLong = t.direction === "long" || t.direction === "BUY";
    const entry = Number(t.entry_price);
    const exit = Number(t.exit_price);
    const peak = Number(t.peak_pre_exit);
    const sl = Number(t.stop_loss_price);
    const tp = Number(t.take_profit_price);
    if (!entry || !peak) continue;
    const mfePct = isLong ? (peak - entry) / entry * 100 : (entry - peak) / entry * 100;
    const realPct = isLong ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    const slPct = sl ? Math.abs((sl - entry) / entry * 100) : NaN;
    const tpPct = tp ? Math.abs((tp - entry) / entry * 100) : NaN;
    const dur = (new Date(t.exit_timestamp as string).getTime() - new Date(t.entry_timestamp as string).getTime()) / 60000;
    enriched.push({
      sym: t.symbol as string,
      class: t.asset_class as string,
      port: PORT[t.portfolio_id as string] ?? (t.portfolio_id as string)?.slice(0,8),
      mfePct, realPct, capturePct: mfePct > 0 ? (realPct / mfePct) * 100 : 0,
      slPct, tpPct,
      exitReason: String(t.exit_reason ?? '').slice(0, 30),
      durationMin: dur,
      wouldHitTPIfNoChoppy: mfePct > tpPct, // si MFE > TP%, le TP aurait été touché
    });
  }

  console.log(`Total trades fermés all-time = ${enriched.length}\n`);

  // 1. Distribution MFE par exit_reason
  console.log('═══ 1. Distribution MFE par exit_reason ═══');
  const byReason: Record<string, { n: number; mfes: number[]; reals: number[]; wins: number }> = {};
  for (const r of enriched) {
    const k = r.exitReason || 'unknown';
    if (!byReason[k]) byReason[k] = { n: 0, mfes: [], reals: [], wins: 0 };
    byReason[k].n++;
    byReason[k].mfes.push(r.mfePct);
    byReason[k].reals.push(r.realPct);
    if (r.realPct > 0) byReason[k].wins++;
  }
  console.log('Exit reason              | n | wins | MFE min  | MFE med  | MFE max  | real avg');
  console.log('-------------------------|---|------|----------|----------|----------|----------');
  for (const [k, b] of Object.entries(byReason).sort((a,b) => b[1].n - a[1].n)) {
    const sorted = [...b.mfes].sort((a,b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const realAvg = b.reals.reduce((s,v) => s + v, 0) / b.n;
    console.log(`${k.padEnd(24)} | ${b.n.toString().padStart(1)} | ${b.wins.toString().padStart(4)} | ${sorted[0].toFixed(2).padStart(7)}% | ${med.toFixed(2).padStart(7)}% | ${sorted[sorted.length-1].toFixed(2).padStart(7)}% | ${realAvg.toFixed(2).padStart(7)}%`);
  }

  // 2. closed_choppy spécifiquement — distribution MFE × outcome
  console.log('\n═══ 2. closed_choppy DEEP DIVE — MFE bucket × outcome ═══');
  const choppy = enriched.filter(r => r.exitReason.includes('choppy'));
  console.log(`closed_choppy total = ${choppy.length}\n`);
  const mfeBuckets = [
    { name: '0.0-0.2%', lo: 0, hi: 0.2 },
    { name: '0.2-0.4%', lo: 0.2, hi: 0.4 },
    { name: '0.4-0.6%', lo: 0.4, hi: 0.6 },
    { name: '0.6-0.8%', lo: 0.6, hi: 0.8 },
    { name: '0.8-1.0%', lo: 0.8, hi: 1.0 },
    { name: '1.0-1.2%', lo: 1.0, hi: 1.2 },
    { name: '1.2-2.0%', lo: 1.2, hi: 2.0 },
    { name: '≥2.0%',   lo: 2.0, hi: 999 },
  ];
  console.log('MFE bucket | n | wins | avg real% | If had let-run, would hit TP?');
  console.log('-----------|---|------|-----------|----------');
  for (const bk of mfeBuckets) {
    const items = choppy.filter(r => r.mfePct >= bk.lo && r.mfePct < bk.hi);
    if (items.length === 0) { console.log(`${bk.name.padEnd(10)} | 0 |   —  |    —     |   —`); continue; }
    const wins = items.filter(r => r.realPct > 0).length;
    const avg = items.reduce((s,r) => s + r.realPct, 0) / items.length;
    const wouldHitTP = items.filter(r => r.wouldHitTPIfNoChoppy).length;
    console.log(`${bk.name.padEnd(10)} | ${items.length} | ${wins.toString().padStart(4)} | ${avg.toFixed(2).padStart(7)}% | ${wouldHitTP}/${items.length} (${items.length > 0 ? Math.round(wouldHitTP/items.length*100) : 0}%)`);
  }

  // 3. Détail par portfolio
  console.log('\n═══ 3. closed_choppy DÉTAIL par portfolio ═══');
  console.log('Port    | Sym         | MFE%   | real%  | TP%   | woudHitTP | capture%');
  console.log('--------|-------------|--------|--------|-------|-----------|--------');
  for (const r of choppy.sort((a,b) => b.mfePct - a.mfePct)) {
    console.log(`${r.port.padEnd(7)} | ${r.sym.padEnd(11)} | ${r.mfePct.toFixed(2).padStart(5)}% | ${r.realPct.toFixed(2).padStart(5)}% | ${(isNaN(r.tpPct) ? '-' : r.tpPct.toFixed(2)).padStart(4)}% | ${r.wouldHitTPIfNoChoppy ? '✓' : '✗'}        | ${r.capturePct.toFixed(0).padStart(4)}%`);
  }

  // 4. Recommandation seuil
  console.log('\n═══ 4. Recommandation seuil empirique ═══');
  // Pour chaque seuil candidat, count : combien de closed_choppy auraient été "saved" + leur outcome
  const candidates = [0.3, 0.5, 0.7, 0.9, 1.0, 1.2];
  console.log('Seuil  | choppy "saved" | wouldHitTP parmi saved | net effect (vs status quo)');
  console.log('-------|----------------|------------------------|------------');
  for (const s of candidates) {
    const saved = choppy.filter(r => r.mfePct >= s);
    const winsSaved = saved.filter(r => r.wouldHitTPIfNoChoppy);
    const lostSaved = saved.filter(r => !r.wouldHitTPIfNoChoppy);
    // Pour les "saved" (qui n'auraient pas closé choppy) :
    //   - les wouldHitTP gagnent +tp%
    //   - les autres potentiellement perdent SL%
    let netEffect = 0;
    for (const r of saved) {
      if (r.wouldHitTPIfNoChoppy) netEffect += r.tpPct - r.realPct;
      else netEffect -= r.slPct + r.realPct; // perte SL au lieu de exit actuel
    }
    console.log(`${s.toFixed(1)}%  | ${saved.length.toString().padStart(14)} | ${winsSaved.length.toString().padStart(22)} | ${netEffect.toFixed(2)}%`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
