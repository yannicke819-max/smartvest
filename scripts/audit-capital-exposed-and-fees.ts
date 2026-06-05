/**
 * Audit du capital réellement exposé sur HIGH oversold le 04/06 + estimation
 * fees broker réelles US corporate (IBKR Pro Tier).
 *
 *   npx tsx scripts/audit-capital-exposed-and-fees.ts
 *
 * 1. Calcule la TIMELINE de l'exposition simultanée :
 *    - À chaque event (entry/exit), récalcule la somme des notionnels ouverts
 *    - Trouve le PEAK exposure et l'heure du peak
 * 2. Estime les fees broker IBKR Pro Tier (= broker de référence US pour société) :
 *    - Tiered : $0.0035/share, min $0.35/order, max 1% trade value
 *    - SEC fee (sell only) : 0.00229% of trade value
 *    - FINRA TAF (sell only) : $0.000166/share max $8.30
 *    - Spread implicite : 0.05% par côté pour Russell 1000 (estimé)
 *    - Slippage : 0.02% par côté (Russell 1000 liquide)
 * 3. Différencie GROSS PnL vs NET PnL (= gross - all fees)
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const HIGH = 'a0000001-0000-0000-0000-000000000001';
function fmt(n: number, d = 2): string { return Number(n).toFixed(d); }
function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }

// IBKR Pro Tier US corporate fees (référence 2026)
const IBKR_TIER1_RATE = 0.0035;          // $/share
const IBKR_MIN_ORDER = 0.35;             // $
const IBKR_MAX_PCT_TRADE = 0.01;         // 1% trade value cap
const SEC_FEE_PCT = 0.0000229;           // 0.00229% of sell proceeds
const FINRA_TAF_RATE = 0.000166;         // $/share (sell only)
const FINRA_TAF_MAX = 8.30;              // $/trade cap
const SPREAD_PCT_PER_SIDE = 0.0005;      // 0.05% bid-ask spread per side (Russell 1000 estim.)
const SLIPPAGE_PCT_PER_SIDE = 0.0002;    // 0.02% slippage per side (liquid)

interface Position {
  symbol: string;
  entry_timestamp: string;
  exit_timestamp: string | null;
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  notional_usd: number;
  realized_pnl_usd: number | null;
  status: string;
}

function ibkrCommission(shares: number, tradeValueUsd: number): number {
  const tiered = Math.max(shares * IBKR_TIER1_RATE, IBKR_MIN_ORDER);
  const capped = Math.min(tiered, tradeValueUsd * IBKR_MAX_PCT_TRADE);
  return capped;
}

function computeAllFees(p: Position): { entryFee: number; exitFee: number; secFee: number; finraFee: number; spread: number; slippage: number; total: number } {
  const entryValue = p.notional_usd;
  const exitValue = p.exit_price != null ? p.quantity * p.exit_price : entryValue;
  const entryFee = ibkrCommission(p.quantity, entryValue);
  const exitFee = ibkrCommission(p.quantity, exitValue);
  const secFee = exitValue * SEC_FEE_PCT;
  const finraFee = Math.min(p.quantity * FINRA_TAF_RATE, FINRA_TAF_MAX);
  const spread = (entryValue + exitValue) * SPREAD_PCT_PER_SIDE;
  const slippage = (entryValue + exitValue) * SLIPPAGE_PCT_PER_SIDE;
  return {
    entryFee, exitFee, secFee, finraFee, spread, slippage,
    total: entryFee + exitFee + secFee + finraFee + spread + slippage,
  };
}

async function main() {
  const { data } = await sb
    .from('lisa_positions')
    .select('symbol, entry_timestamp, exit_timestamp, entry_price, exit_price, quantity, entry_notional_usd, realized_pnl_usd, status')
    .eq('portfolio_id', HIGH)
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .gte('entry_timestamp', '2026-06-04T00:00:00Z')
    .lt('entry_timestamp', '2026-06-05T00:00:00Z')
    .order('entry_timestamp', { ascending: true });

  if (!data?.length) {
    console.log('Aucune position');
    return;
  }

  const positions: Position[] = data.map(p => ({
    symbol: p.symbol as string,
    entry_timestamp: p.entry_timestamp as string,
    exit_timestamp: p.exit_timestamp as string | null,
    entry_price: parseFloat(String(p.entry_price)),
    exit_price: p.exit_price != null ? parseFloat(String(p.exit_price)) : null,
    quantity: parseFloat(String(p.quantity ?? 0)),
    notional_usd: parseFloat(String(p.entry_notional_usd ?? 0)),
    realized_pnl_usd: p.realized_pnl_usd != null ? Number(p.realized_pnl_usd) : null,
    status: p.status as string,
  }));

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' 1. CAPITAL EXPOSÉ — Timeline d\'exposition simultanée HIGH 04/06');
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  // Build timeline of events
  type Event = { ts: string; type: 'in' | 'out'; notional: number; symbol: string };
  const events: Event[] = [];
  for (const p of positions) {
    events.push({ ts: p.entry_timestamp, type: 'in', notional: p.notional_usd, symbol: p.symbol });
    if (p.exit_timestamp) events.push({ ts: p.exit_timestamp, type: 'out', notional: p.notional_usd, symbol: p.symbol });
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));

  let currentExposure = 0;
  let peakExposure = 0;
  let peakTs = '';
  let peakOpenCount = 0;
  let currentOpens = 0;
  const milestones: Array<{ ts: string; exposure: number; opens: number }> = [];
  for (const e of events) {
    if (e.type === 'in') { currentExposure += e.notional; currentOpens++; }
    else { currentExposure -= e.notional; currentOpens--; }
    if (currentExposure > peakExposure) {
      peakExposure = currentExposure;
      peakTs = e.ts;
      peakOpenCount = currentOpens;
    }
    milestones.push({ ts: e.ts, exposure: currentExposure, opens: currentOpens });
  }

  const totalTurnover = positions.reduce((s, p) => s + p.notional_usd, 0);
  console.log(`  Total positions ouvertes (turnover) : ${positions.length} × notional moyen $${(totalTurnover / positions.length).toFixed(0)} = $${totalTurnover.toFixed(0)}`);
  console.log(`  PEAK EXPOSURE SIMULTANÉ              : $${peakExposure.toFixed(0)}  @ ${peakTs.slice(11, 16)} UTC  (${peakOpenCount} positions ouvertes)`);
  console.log(`  Capital config HIGH                  : $150,000`);
  console.log(`  Ratio peak / capital config          : ${((peakExposure / 150000) * 100).toFixed(0)}%  → ${peakExposure < 50000 ? '✅ surdimensionné' : '⚠ utilisé'}`);

  console.log('\n  Échantillon timeline (10 plus gros pics) :');
  const sorted = [...milestones].sort((a, b) => b.exposure - a.exposure).slice(0, 8);
  for (const m of sorted) {
    console.log(`    ${m.ts.slice(11, 16)} UTC : $${pad(m.exposure.toFixed(0), 7)} (${m.opens} positions)`);
  }

  // 2. Fees analysis
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' 2. FEES BROKER IBKR Pro Tier (référence US corporate)');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  Hypothèses tarif IBKR Pro Tier US corporate :');
  console.log(`    Commission tiered     : $${IBKR_TIER1_RATE}/share, min $${IBKR_MIN_ORDER}/order, max ${(IBKR_MAX_PCT_TRADE*100).toFixed(2)}% trade value`);
  console.log(`    SEC fee (sell)        : ${(SEC_FEE_PCT*100).toFixed(4)}% of trade value`);
  console.log(`    FINRA TAF (sell)      : $${FINRA_TAF_RATE}/share, max $${FINRA_TAF_MAX}/trade`);
  console.log(`    Spread implicite      : ${(SPREAD_PCT_PER_SIDE*100).toFixed(2)}%/side (Russell 1000 estimé)`);
  console.log(`    Slippage              : ${(SLIPPAGE_PCT_PER_SIDE*100).toFixed(2)}%/side (liquid)`);

  let sumEntryFee = 0, sumExitFee = 0, sumSec = 0, sumFinra = 0, sumSpread = 0, sumSlip = 0, sumGross = 0;
  const closedPositions = positions.filter(p => p.exit_price != null && p.realized_pnl_usd != null);
  for (const p of closedPositions) {
    const fees = computeAllFees(p);
    sumEntryFee += fees.entryFee;
    sumExitFee += fees.exitFee;
    sumSec += fees.secFee;
    sumFinra += fees.finraFee;
    sumSpread += fees.spread;
    sumSlip += fees.slippage;
    sumGross += p.realized_pnl_usd ?? 0;
  }
  const totalFees = sumEntryFee + sumExitFee + sumSec + sumFinra + sumSpread + sumSlip;
  const netPnl = sumGross - totalFees;

  console.log(`\n  Sur ${closedPositions.length} closed positions HIGH 04/06 :`);
  console.log(`    Σ Commission entries  : $${fmt(sumEntryFee)}`);
  console.log(`    Σ Commission exits    : $${fmt(sumExitFee)}`);
  console.log(`    Σ SEC fee (sells)     : $${fmt(sumSec)}`);
  console.log(`    Σ FINRA TAF (sells)   : $${fmt(sumFinra)}`);
  console.log(`    Σ Spread implicite    : $${fmt(sumSpread)}`);
  console.log(`    Σ Slippage estimé     : $${fmt(sumSlip)}`);
  console.log(`                           ─────────`);
  console.log(`    Σ TOTAL FEES          : $${fmt(totalFees)}`);
  console.log(`\n  ┌─────────────────────────────────────────────────┐`);
  console.log(`  │   GROSS PnL (avant fees)   : $${pad(fmt(sumGross), 8)}        │`);
  console.log(`  │   - Total fees             : $${pad(fmt(totalFees), 8)}        │`);
  console.log(`  │   = NET PnL (after fees)   : $${pad(fmt(netPnl), 8)}        │`);
  console.log(`  │   Ratio fees/gross         : ${pad(fmt((totalFees/sumGross)*100, 1), 5)}%               │`);
  console.log(`  └─────────────────────────────────────────────────┘`);

  // 3. What capital would suffice ?
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' 3. CAPITAL MINIMUM RECOMMANDÉ');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  const recommended = Math.ceil(peakExposure * 1.5 / 1000) * 1000;
  const factor = (150000 / peakExposure).toFixed(1);
  console.log(`  Peak exposure observé        : $${peakExposure.toFixed(0)}`);
  console.log(`  + Marge sécurité 1.5x        : $${(peakExposure * 1.5).toFixed(0)}`);
  console.log(`  → Capital recommandé         : $${recommended}  (vs $150,000 actuel)`);
  console.log(`  Surdimensionnement actuel    : ${factor}x  (capital réel à dégager seulement ${(100 * peakExposure / 150000).toFixed(0)}%)`);
  console.log(`\n  AVEC LE CAPITAL RECOMMANDÉ ($${recommended}) :`);
  console.log(`    Tu peux générer les mêmes $${fmt(sumGross)} gross / $${fmt(netPnl)} net du 04/06`);
  console.log(`    Capital DORMANT actuel ($150k − $${recommended}) = $${150000 - recommended} libre pour autre stratégie`);

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
