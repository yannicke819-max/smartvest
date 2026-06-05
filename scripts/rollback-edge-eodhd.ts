/**
 * ROLLBACK EDGE — version EODHD intraday (vraies données prix).
 *
 * Pour chaque candidat rejeté, fetch /api/intraday/{symbol} EODHD avec
 * interval=5m sur la fenêtre [rejet, rejet+60min] et mesure :
 *   - max_high atteint
 *   - delta_max_pct = (max_high - entry_price) / entry_price * 100
 *
 * Verdict :
 *   🟢 GOOD-REJECT  : max_delta < 0.5% (rejet correct)
 *   🟡 MARGINAL     : 0.5% - 1.5%
 *   🔴 BAD-REJECT   : ≥ 1.5% (gate a raté un pump réel)
 *
 *   npx tsx scripts/rollback-edge-eodhd.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const EODHD_KEY = process.env.EODHD_API_KEY ?? '69e6325aa2c162.98850425';
const SAMPLE_PER_CLASS = 100; // limit pour éviter 1000+ fetches

function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }
function fmt(n: number, d = 2): string { return Number(n).toFixed(d); }

async function fetchIntradayMax(symbol: string, fromUnix: number, toUnix: number): Promise<number | null> {
  const url = `https://eodhd.com/api/intraday/${encodeURIComponent(symbol)}?interval=5m&from=${fromUnix}&to=${toUnix}&api_token=${EODHD_KEY}&fmt=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json() as Array<{ timestamp: number; high: number; close: number }>;
    if (!Array.isArray(json) || json.length === 0) return null;
    const highs = json.map(b => Number(b.high ?? b.close)).filter(h => Number.isFinite(h) && h > 0);
    return highs.length > 0 ? Math.max(...highs) : null;
  } catch { return null; }
}

async function main() {
  const since = new Date(Date.now() - 72 * 3600_000).toISOString();
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' ROLLBACK EDGE via EODHD intraday — vraies données post-rejet');
  console.log(`   Fenêtre : 72h, sample ${SAMPLE_PER_CLASS}/class, EODHD key: ${EODHD_KEY.slice(0,12)}...`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const classes = ['us_equity_large', 'us_equity_small_mid', 'eu_equity'];
  type Reject = { symbol: string; cls: string; gate: string; entryPrice: number; createdAt: string };
  const rejects: Reject[] = [];
  for (const cls of classes) {
    const { data } = await sb
      .from('gainers_user_shadow_signals')
      .select('symbol, asset_class, decision, entry_price, created_at')
      .eq('asset_class', cls)
      .neq('decision', 'accept')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(SAMPLE_PER_CLASS);
    for (const r of data ?? []) {
      const ep = Number(r.entry_price);
      if (Number.isFinite(ep) && ep > 0) {
        rejects.push({
          symbol: r.symbol as string,
          cls: r.asset_class as string,
          gate: r.decision as string,
          entryPrice: ep,
          createdAt: r.created_at as string,
        });
      }
    }
  }
  console.log(`Loaded ${rejects.length} rejected candidates US/EU 72h\n`);

  // Fetch intraday for each (parallèle par batch de 5 pour éviter rate-limit)
  type Outcome = { gate: string; cls: string; symbol: string; entryPrice: number; maxAfter: number; deltaPct: number };
  const outcomes: Outcome[] = [];
  const BATCH = 5;
  for (let i = 0; i < rejects.length; i += BATCH) {
    const batch = rejects.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (r) => {
      const t0 = Math.floor(new Date(r.createdAt).getTime() / 1000);
      const t60 = t0 + 60 * 60;
      const max = await fetchIntradayMax(r.symbol, t0, t60);
      if (max == null) return null;
      const delta = ((max - r.entryPrice) / r.entryPrice) * 100;
      return { gate: r.gate, cls: r.cls, symbol: r.symbol, entryPrice: r.entryPrice, maxAfter: max, deltaPct: delta };
    }));
    for (const r of results) if (r) outcomes.push(r);
    process.stdout.write(`\r  Progress : ${Math.min(i + BATCH, rejects.length)}/${rejects.length}`);
  }
  console.log(`\n\nAnalysed ${outcomes.length}/${rejects.length} rejects with EODHD data\n`);

  // Aggregate by gate
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
  console.log(' EDGE par gate (% des rejets qui ont eu un pump > 1.5% dans les 60 min)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  console.log(`${pad('GATE', 32)} ${pad('Sample', 7)} ${pad('🟢 GOOD', 10)} ${pad('🟡 NEUT', 9)} ${pad('🔴 BAD', 9)} ${pad('Avg BAD edge', 14)} ${pad('% BAD', 8)}`);
  console.log('─'.repeat(95));
  const sorted = [...byGate].sort((a, b) => b[1].n - a[1].n);
  for (const [gate, s] of sorted) {
    const avgBad = s.bad > 0 ? `+${fmt(s.sumBadDelta / s.bad)}%` : 'n/a';
    const pctBad = s.n > 0 ? `${fmt((s.bad / s.n) * 100, 0)}%` : '–';
    const flag = s.bad / s.n >= 0.3 ? '⚠' : s.bad / s.n >= 0.15 ? '·' : ' ';
    console.log(`${pad(flag + ' ' + gate, 32)} ${pad(s.n, 7)} ${pad(s.good, 10)} ${pad(s.neutral, 9)} ${pad(s.bad, 9)} ${pad(avgBad, 14)} ${pad(pctBad, 8)}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' TOP 15 candidats rejetés qui ont VRAIMENT pumpé (gates les plus coupables)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  const allBad: Array<{ gate: string; sym: string; delta: number }> = [];
  for (const [gate, s] of byGate) for (const m of s.topMissed) allBad.push({ gate, sym: m.sym, delta: m.delta });
  allBad.sort((a, b) => b.delta - a.delta);
  console.log(`${pad('SYMBOL', 14)} ${pad('REJECTED BY', 32)} EDGE RATÉ +60min`);
  for (const m of allBad.slice(0, 15)) {
    console.log(`${pad(m.sym, 14)} ${pad(m.gate, 32)} +${fmt(m.delta)}%`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
