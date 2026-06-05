/**
 * ROLLBACK des candidats rejetés — mesure empirique de l'edge raté/évité
 * par chaque gate, via top_gainers_log qui log chaque cycle.
 *
 * Pour chaque candidat rejeté à T :
 *   1. Cherche TOUS les rows du même symbole entre T et T+60min dans top_gainers_log
 *   2. Calcule : max_price reached + final_price + max_delta_pct
 *   3. Classifie :
 *      - 🟢 GOOD-REJECT : prix max_60min < +0.5% (rejet justifié, pas de pump)
 *      - 🟡 NEUTRAL    : max entre +0.5% et +1.5% (marginal)
 *      - 🔴 BAD-REJECT : max ≥ +1.5% (gate a raté un gain)
 *
 * Output : pour chaque gate, le % de BAD rejects + l'edge moyen raté.
 *
 *   npx tsx scripts/rollback-rejected-edge.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }

interface ShadowReject {
  symbol: string;
  asset_class: string;
  decision: string;
  entry_price: number | null;
  created_at: string;
}

async function main() {
  const since = new Date(Date.now() - 72 * 3600_000).toISOString();

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' ROLLBACK EDGE des candidats rejetés (via top_gainers_log)');
  console.log(`   Fenêtre : 72h - mesure max_price atteint dans les 60 min après rejet`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // 1. Load rejected candidates 72h (sample 200 per asset_class pour vitesse)
  const classes = ['us_equity_large', 'us_equity_small_mid', 'eu_equity'];
  const allRejects: ShadowReject[] = [];
  for (const cls of classes) {
    const { data } = await sb
      .from('gainers_user_shadow_signals')
      .select('symbol, asset_class, decision, entry_price, created_at')
      .eq('asset_class', cls)
      .neq('decision', 'accept')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200);
    allRejects.push(...((data ?? []) as ShadowReject[]));
  }
  console.log(`Loaded ${allRejects.length} rejected candidates US/EU 72h\n`);

  // 2. Pour chaque reject, mesurer la trajectoire post-rejet
  type Outcome = { gate: string; cls: string; symbol: string; rejectPrice: number; maxAfter: number; deltaMaxPct: number };
  const outcomes: Outcome[] = [];
  for (const r of allRejects) {
    if (!r.entry_price || r.entry_price <= 0) continue;
    const t0 = new Date(r.created_at).getTime();
    const t60 = new Date(t0 + 60 * 60_000).toISOString();
    const { data: future } = await sb
      .from('top_gainers_log')
      .select('captured_at, close_price, high_price')
      .eq('symbol', r.symbol)
      .gte('captured_at', r.created_at)
      .lt('captured_at', t60)
      .order('captured_at', { ascending: true });
    if (!future?.length) continue;
    const maxHigh = Math.max(...future.map(f => Number(f.high_price ?? f.close_price)));
    const deltaPct = ((maxHigh - r.entry_price) / r.entry_price) * 100;
    outcomes.push({
      gate: r.decision,
      cls: r.asset_class,
      symbol: r.symbol,
      rejectPrice: r.entry_price,
      maxAfter: maxHigh,
      deltaMaxPct: deltaPct,
    });
  }

  console.log(`Analysed ${outcomes.length}/${allRejects.length} rejects with subsequent log data\n`);

  // 3. Aggregate by gate
  type Stats = { n: number; good: number; neutral: number; bad: number; sumDeltaBad: number; topMissed: Array<{ sym: string; cls: string; delta: number }> };
  const byGate = new Map<string, Stats>();
  for (const o of outcomes) {
    const acc = byGate.get(o.gate) ?? { n: 0, good: 0, neutral: 0, bad: 0, sumDeltaBad: 0, topMissed: [] };
    acc.n++;
    if (o.deltaMaxPct >= 1.5) {
      acc.bad++;
      acc.sumDeltaBad += o.deltaMaxPct;
      acc.topMissed.push({ sym: o.symbol, cls: o.cls, delta: o.deltaMaxPct });
    } else if (o.deltaMaxPct >= 0.5) acc.neutral++;
    else acc.good++;
    byGate.set(o.gate, acc);
  }

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' EDGE MOYEN par gate de rejet (sur les "bad rejects" qui ont pumpé après)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  console.log(`${pad('GATE', 32)} ${pad('Sample', 7)} ${pad('🟢 GOOD', 10)} ${pad('🟡 NEUT', 9)} ${pad('🔴 BAD', 9)} ${pad('AVG edge raté', 14)} ${pad('% BAD', 8)}`);
  console.log('─'.repeat(95));
  const sorted = [...byGate].sort((a, b) => b[1].n - a[1].n);
  for (const [gate, s] of sorted) {
    const avgBad = s.bad > 0 ? (s.sumDeltaBad / s.bad).toFixed(2) + '%' : 'n/a';
    const pctBad = s.n > 0 ? ((s.bad / s.n) * 100).toFixed(0) + '%' : '–';
    console.log(`${pad(gate, 32)} ${pad(s.n, 7)} ${pad(s.good, 10)} ${pad(s.neutral, 9)} ${pad(s.bad, 9)} ${pad(avgBad, 14)} ${pad(pctBad, 8)}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' TOP 15 missed gold (gates qui ont rejeté un pump réel)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  const allBad: Array<{ gate: string; sym: string; cls: string; delta: number }> = [];
  for (const [gate, s] of byGate) {
    for (const m of s.topMissed) allBad.push({ gate, ...m });
  }
  allBad.sort((a, b) => b.delta - a.delta);
  console.log(`${pad('SYMBOL', 12)} ${pad('CLASS', 22)} ${pad('REJECTED BY', 32)} MAX EDGE +60min`);
  for (const m of allBad.slice(0, 15)) {
    console.log(`${pad(m.sym, 12)} ${pad(m.cls, 22)} ${pad(m.gate, 32)} +${m.delta.toFixed(2)}%`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
