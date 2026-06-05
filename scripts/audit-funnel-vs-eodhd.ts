/**
 * Audit funnel EU TRADER (60min) + comparaison avec EODHD live screener.
 * Objectif : identifier les vrais top gainers EU qui sont passés à la trappe.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const EODHD = process.env.EODHD_API_KEY ?? '69e6325aa2c162.98850425';

async function fetchEodhdScreener(exchange: string, minChange = 3, maxRows = 30): Promise<Array<{ code: string; refund_1d_p: number; market_cap: number; avgvol_1d: number; last_day: string }>> {
  const filters = encodeURIComponent(JSON.stringify([
    ['exchange', '=', exchange],
    ['refund_1d_p', '>', minChange],
    ['market_capitalization', '>', 50_000_000],
  ]));
  const url = `https://eodhd.com/api/screener?api_token=${EODHD}&fmt=json&sort=refund_1d_p.desc&limit=${maxRows}&filters=${filters}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const json = await res.json() as { data: Array<{ code: string; refund_1d_p: number; market_capitalization: number; avgvol_1d: number; last_day_data_date: string }> };
    return (json.data ?? []).map(r => ({
      code: r.code,
      refund_1d_p: Number(r.refund_1d_p ?? 0),
      market_cap: Number(r.market_capitalization ?? 0),
      avgvol_1d: Number(r.avgvol_1d ?? 0),
      last_day: String(r.last_day_data_date ?? ''),
    }));
  } catch { return []; }
}

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since60 = new Date(Date.now() - 60 * 60_000).toISOString();
  console.log(`\n═══════════════════════════════════════════════════════════════════════`);
  console.log(` AUDIT FUNNEL EU + VRAIS TOP GAINERS EODHD — ${new Date().toISOString().slice(11,19)} UTC`);
  console.log(`═══════════════════════════════════════════════════════════════════════\n`);

  // 1. FUNNEL — scanner TRADER 60min
  console.log(`──── 1. FUNNEL TRADER EU 60min ────\n`);
  const { data: shadow } = await sb
    .from('gainers_user_shadow_signals')
    .select('symbol, decision, entry_price')
    .eq('asset_class', 'eu_equity')
    .gte('created_at', since60);
  const shadowDecisions = new Map<string, number>();
  const shadowSymbols = new Set<string>();
  for (const s of shadow ?? []) {
    shadowDecisions.set(s.decision, (shadowDecisions.get(s.decision) ?? 0) + 1);
    if (s.decision === 'accept') shadowSymbols.add(s.symbol);
  }
  const totalShadow = shadow?.length ?? 0;
  console.log(`Shadow signals EU : ${totalShadow}`);
  for (const [d, n] of [...shadowDecisions].sort((a,b) => b[1]-a[1])) {
    const pct = totalShadow > 0 ? (n/totalShadow*100).toFixed(0) : '0';
    console.log(`  ${d.padEnd(28)} : ${n} (${pct}%)`);
  }

  // 2. Proposals + bypass
  const { data: props } = await sb
    .from('scanner_proposals')
    .select('symbol, score, change_pct, status')
    .eq('portfolio_id', TRADER)
    .eq('asset_class', 'eu_equity')
    .gte('created_at', since60);
  const propSymbols = new Set<string>();
  const propScores = new Map<string, number>();
  for (const p of props ?? []) {
    propSymbols.add(p.symbol);
    propScores.set(p.symbol, Math.max(propScores.get(p.symbol) ?? 0, Number(p.score ?? 0)));
  }
  console.log(`\nProposals EU générés : ${props?.length ?? 0} (${propSymbols.size} unique)`);

  // 3. Ouvertures et fermetures
  const { data: positions } = await sb
    .from('lisa_positions')
    .select('symbol, status, entry_price, exit_price, entry_timestamp, exit_timestamp, realized_pnl_usd, exit_reason')
    .eq('portfolio_id', TRADER)
    .gte('entry_timestamp', since60);
  const euPositions = (positions ?? []).filter(p =>
    /\.(LSE|XETRA|PA|AS|SW|F)$/.test(p.symbol.toUpperCase())
  );
  console.log(`\nPositions EU ouvertes 60min : ${euPositions.length}`);
  let netPnl = 0;
  for (const p of euPositions) {
    const pnl = Number(p.realized_pnl_usd ?? 0);
    netPnl += pnl;
    console.log(`  ${p.entry_timestamp.slice(11,19)} ${p.symbol.padEnd(14)} ${p.status.padEnd(20)} pnl=$${pnl.toFixed(2)}`);
  }
  console.log(`  Net PnL : $${netPnl.toFixed(2)}`);

  // 4. EODHD live screener LSE + XETRA + PA
  console.log(`\n──── 4. EODHD LIVE SCREENER (top 30/exchange, > 3%, market cap > 50M) ────\n`);
  const exchanges: Array<'LSE' | 'XETRA' | 'PA'> = ['LSE', 'XETRA', 'PA'];
  const eodhdAll: Array<{ symbol: string; exchange: string; change: number; vol: number; last: string }> = [];
  for (const ex of exchanges) {
    const rows = await fetchEodhdScreener(ex);
    console.log(`\n  ${ex} — ${rows.length} candidats EODHD :`);
    for (const r of rows.slice(0, 15)) {
      const isAberrant = r.refund_1d_p > 50;
      const tag = isAberrant ? '🚫 fantôme (filtered)' : '';
      console.log(`    ${r.code.padEnd(12)} change=${r.refund_1d_p.toFixed(1)}% vol=${(r.avgvol_1d/1000).toFixed(0)}k market=$${(r.market_cap/1e6).toFixed(0)}M last_day=${r.last_day} ${tag}`);
      if (!isAberrant) {
        eodhdAll.push({ symbol: `${r.code}.${ex}`, exchange: ex, change: r.refund_1d_p, vol: r.avgvol_1d, last: r.last_day });
      }
    }
  }

  // 5. CROSS-CHECK : vrais top gainers EODHD vs ce que le scanner a vu
  console.log(`\n──── 5. VRAIS TOP GAINERS EU NON-VUS PAR LE SCANNER ────\n`);
  const allLegit = eodhdAll.sort((a,b) => b.change - a.change);
  let missed = 0;
  for (const r of allLegit) {
    const seen = shadowSymbols.has(r.symbol) || propSymbols.has(r.symbol);
    if (!seen) {
      missed++;
      console.log(`  ❌ ${r.symbol.padEnd(14)} change=${r.change.toFixed(1)}% vol=${(r.vol/1000).toFixed(0)}k last_day=${r.last}`);
    }
  }
  if (missed === 0) console.log('  ✅ Tous les vrais top gainers EODHD sont vus par le scanner');
  console.log(`\nTotal manqués : ${missed} / ${allLegit.length} vrais top gainers EODHD`);

  // 6. Vrais top gainers vus mais non bypassed (score < 0.35)
  console.log(`\n──── 6. VRAIS TOP GAINERS EU vus mais non bypassed (score < 0.35) ────\n`);
  for (const r of allLegit) {
    const score = propScores.get(r.symbol);
    if (score != null && score < 0.35) {
      console.log(`  🟡 ${r.symbol.padEnd(14)} change=${r.change.toFixed(1)}% score=${score.toFixed(2)} (LLM décide → souvent hold)`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
