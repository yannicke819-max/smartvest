/**
 * ROLLBACK EODHD ciblé sur les VRAIS blockages TRADER NYSE 2026-06-04 14:30-21:00 UTC.
 *
 * Source = lisa_decision_log (pas gainers_user_shadow_signals) car les vrais
 * blockages sont POST-shadow (DebateGate, CLIMAX_RUN, VERTICAL_PUMP, StaleSource,
 * TopTickDrift).
 *
 * Pour chaque event blockage :
 *   1. Fetch EODHD intraday 5m sur [event_time - 5min, event_time + 60min]
 *   2. Prix entry = première barre après event_time
 *   3. Prix max = max(high) dans la fenêtre
 *   4. Delta = (max - entry) / entry × 100
 *
 * Classification :
 *   🟢 GOOD-REJECT < +0.5%
 *   🟡 MARGINAL  0.5%-1.5%
 *   🔴 BAD-REJECT ≥ +1.5%
 *
 *   npx tsx scripts/rollback-trader-nyse-blockers.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const EODHD_KEY = process.env.EODHD_API_KEY ?? '69e6325aa2c162.98850425';
const TRADER_PORTFOLIO = 'b0000001-0000-0000-0000-000000000001';
const NYSE_FROM = '2026-06-04T14:30:00.000Z';
const NYSE_TO = '2026-06-04T21:00:00.000Z';

function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }
function fmt(n: number, d = 2): string { return Number(n).toFixed(d); }

interface Blockage {
  symbol: string;
  gateLabel: string;
  ts: string;
  assetClass: string;
  hintPrice?: number;
}

async function fetchIntradayBars(symbol: string, fromUnix: number, toUnix: number): Promise<Array<{ ts: number; high: number; close: number }>> {
  const url = `https://eodhd.com/api/intraday/${encodeURIComponent(symbol)}?interval=5m&from=${fromUnix}&to=${toUnix}&api_token=${EODHD_KEY}&fmt=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = await res.json() as Array<{ timestamp: number; high: number; close: number; open: number }>;
    if (!Array.isArray(json)) return [];
    return json
      .map(b => ({ ts: Number(b.timestamp), high: Number(b.high ?? b.close), close: Number(b.close) }))
      .filter(b => Number.isFinite(b.ts) && Number.isFinite(b.high) && b.high > 0);
  } catch { return []; }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' ROLLBACK EODHD — TRADER NYSE 2026-06-04 14:30-21:00 UTC');
  console.log(' Mesure du vrai edge des candidats VRAIMENT bloqués (post-shadow gates)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // 1. Récupérer les vrais blockages dans decision_log
  const blockages: Blockage[] = [];

  // scanner_candidate_skip : DebateGate (WAIT/HOLD/CHASE), CLIMAX_RUN, VERTICAL_PUMP
  const { data: skips } = await sb
    .from('lisa_decision_log')
    .select('timestamp, payload')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .eq('kind', 'scanner_candidate_skip')
    .gte('timestamp', NYSE_FROM)
    .lt('timestamp', NYSE_TO);

  for (const s of skips ?? []) {
    const p = s.payload as any;
    const gate = p?.gate;
    const symbol = p?.symbol;
    const assetClass = p?.asset_class ?? 'unknown';
    if (!symbol) continue;
    // Skip CHOP_NOISE blind_pass (fail-open, pas un vrai skip)
    if (gate === 'CHOP_NOISE' && p?.verdict === 'blind_pass') continue;
    let gateLabel = gate ?? 'unknown';
    if (gate === 'debate_gate') gateLabel = `debate_gate_${p?.reason ?? 'unknown'}`;
    blockages.push({ symbol, gateLabel, ts: s.timestamp, assetClass });
  }

  // position_open_failed : StaleOrFallbackSource, TopTickDriftGuard
  const { data: fails } = await sb
    .from('lisa_decision_log')
    .select('timestamp, payload')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .eq('kind', 'position_open_failed')
    .gte('timestamp', NYSE_FROM)
    .lt('timestamp', NYSE_TO);

  for (const f of fails ?? []) {
    const p = f.payload as any;
    const symbol = p?.symbol;
    const assetClass = p?.asset_class ?? 'unknown';
    const errorClass = p?.error_class ?? 'unknown';
    if (!symbol) continue;
    const hintPrice = p?.live_price ? Number(p.live_price) : (p?.price ? Number(p.price) : undefined);
    blockages.push({ symbol, gateLabel: `open_fail_${errorClass}`, ts: f.timestamp, assetClass, hintPrice });
  }

  console.log(`Loaded ${blockages.length} vrais blockages TRADER (post-shadow)\n`);

  // 2. Fetch EODHD pour chaque blockage (parallèle batch 5)
  type Outcome = { gate: string; cls: string; symbol: string; ts: string; entryPrice: number; maxAfter: number; deltaPct: number };
  const outcomes: Outcome[] = [];
  const BATCH = 5;
  for (let i = 0; i < blockages.length; i += BATCH) {
    const batch = blockages.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (b) => {
      const t0 = Math.floor(new Date(b.ts).getTime() / 1000);
      const tStart = t0 - 5 * 60;
      const tEnd = t0 + 60 * 60;
      const bars = await fetchIntradayBars(b.symbol, tStart, tEnd);
      if (bars.length === 0) return null;
      // Entry price = première barre à partir de t0 (ou hintPrice si présent)
      const entryBar = bars.find(bb => bb.ts >= t0) ?? bars[0];
      const entryPrice = b.hintPrice ?? entryBar.close ?? entryBar.high;
      if (!entryPrice || entryPrice <= 0) return null;
      // Max high dans les 60 min après
      const futureBars = bars.filter(bb => bb.ts >= t0 && bb.ts <= t0 + 60 * 60);
      if (futureBars.length === 0) return null;
      const maxHigh = Math.max(...futureBars.map(bb => bb.high));
      const deltaPct = ((maxHigh - entryPrice) / entryPrice) * 100;
      return { gate: b.gateLabel, cls: b.assetClass, symbol: b.symbol, ts: b.ts, entryPrice, maxAfter: maxHigh, deltaPct };
    }));
    for (const r of results) if (r) outcomes.push(r);
    process.stdout.write(`\r  Progress : ${Math.min(i + BATCH, blockages.length)}/${blockages.length}`);
  }
  console.log(`\n\nAnalysed ${outcomes.length}/${blockages.length} blockages avec data EODHD\n`);

  // 3. Aggregate par gate
  type Stats = { n: number; good: number; neutral: number; bad: number; sumBadDelta: number; topMissed: Array<{ sym: string; delta: number }> };
  const byGate = new Map<string, Stats>();
  for (const o of outcomes) {
    const acc = byGate.get(o.gate) ?? { n: 0, good: 0, neutral: 0, bad: 0, sumBadDelta: 0, topMissed: [] };
    acc.n++;
    if (o.deltaPct >= 1.5) { acc.bad++; acc.sumBadDelta += o.deltaPct; acc.topMissed.push({ sym: o.symbol, delta: o.deltaPct }); }
    else if (o.deltaPct >= 0.5) acc.neutral++;
    else acc.good++;
    byGate.set(o.gate, acc);
  }

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' EDGE par GATE de rejet TRADER (NYSE 2026-06-04)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  console.log(`${pad('GATE', 38)} ${pad('Sample', 7)} ${pad('🟢 GOOD', 9)} ${pad('🟡 NEUT', 9)} ${pad('🔴 BAD', 8)} ${pad('Avg BAD edge', 14)} ${pad('% BAD', 7)}`);
  console.log('─'.repeat(95));
  const sorted = [...byGate].sort((a, b) => b[1].n - a[1].n);
  for (const [gate, s] of sorted) {
    const avgBad = s.bad > 0 ? `+${fmt(s.sumBadDelta / s.bad)}%` : 'n/a';
    const pctBad = s.n > 0 ? `${fmt((s.bad / s.n) * 100, 0)}%` : '–';
    const flag = s.bad / s.n >= 0.3 ? '⚠' : s.bad / s.n >= 0.15 ? '·' : ' ';
    console.log(`${pad(flag + ' ' + gate, 38)} ${pad(s.n, 7)} ${pad(s.good, 9)} ${pad(s.neutral, 9)} ${pad(s.bad, 8)} ${pad(avgBad, 14)} ${pad(pctBad, 7)}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' TOP 15 candidats rejetés qui ont VRAIMENT pumpé (gates les plus coupables)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  const allBad: Array<{ gate: string; sym: string; delta: number }> = [];
  for (const [gate, s] of byGate) for (const m of s.topMissed) allBad.push({ gate, sym: m.sym, delta: m.delta });
  allBad.sort((a, b) => b.delta - a.delta);
  console.log(`${pad('SYMBOL', 14)} ${pad('REJECTED BY', 38)} EDGE RATÉ +60min`);
  for (const m of allBad.slice(0, 15)) {
    console.log(`${pad(m.sym, 14)} ${pad(m.gate, 38)} +${fmt(m.delta)}%`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' VERDICT GLOBAL');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  const totalN = outcomes.length;
  const totalBad = outcomes.filter(o => o.deltaPct >= 1.5).length;
  const totalGood = outcomes.filter(o => o.deltaPct < 0.5).length;
  const sumBadAll = outcomes.filter(o => o.deltaPct >= 1.5).reduce((s, o) => s + o.deltaPct, 0);
  console.log(`Total mesurés : ${totalN}`);
  console.log(`🟢 GOOD-REJECT (justifiés)  : ${totalGood} (${fmt((totalGood/totalN)*100, 0)}%)`);
  console.log(`🔴 BAD-REJECT (pumps ratés) : ${totalBad} (${fmt((totalBad/totalN)*100, 0)}%)`);
  if (totalBad > 0) {
    console.log(`   Edge moyen raté : +${fmt(sumBadAll/totalBad)}%`);
    console.log(`   Sum edge raté : +${fmt(sumBadAll)}% sur la session`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
