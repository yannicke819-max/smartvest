/**
 * Audit EXIT-EDGE — quantifie l'argent laissé sur la table par exits prématurés.
 *
 * Pour chaque position TRADER fermée :
 *   1. Fetch EODHD candles 5m entre entry et exit (+ buffer)
 *   2. Calcule MFE réel (meilleur prix favorable pendant le hold)
 *   3. Compare au prix d'exit réel
 *   4. Flag "edge laissé" si MFE ≥ TP cible mais exit < TP
 *
 * Sortie : combien de closed_choppy / orphan_close / etc. avaient un MFE
 * ≥ +1.5% ou +2% non capturé → confirme (ou infirme) que le problème est l'EXIT.
 *
 * Usage : EODHD_API_KEY=xxx npx tsx scripts/audit-exit-edge.ts [--limit=150]
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY!;
const EODHD_KEY = env.EODHD_API_KEY ?? process.env.EODHD_API_KEY;
if (!EODHD_KEY) { console.error('❌ EODHD_API_KEY absent'); process.exit(1); }

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const TRADER = 'b0000001-0000-0000-0000-000000000001';
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length) ?? '200');

interface Candle { ts: number; high: number; low: number; close: number; }
const cache = new Map<string, Candle[]>();

async function fetchCandles5m(symbol: string, fromTs: number, toTs: number): Promise<Candle[]> {
  const key = `${symbol}::${fromTs}::${toTs}`;
  const hit = cache.get(key); if (hit) return hit;
  const url = `https://eodhd.com/api/intraday/${encodeURIComponent(symbol)}?api_token=${EODHD_KEY}&interval=5m&from=${fromTs}&to=${toTs}&fmt=json`;
  try {
    const r = await fetch(url);
    if (!r.ok) { cache.set(key, []); return []; }
    const arr = await r.json() as any[];
    const candles = (arr ?? []).map((x) => ({ ts: x.timestamp * 1000, high: Number(x.high), low: Number(x.low), close: Number(x.close) }))
      .filter((c) => Number.isFinite(c.close) && c.close > 0);
    cache.set(key, candles);
    return candles;
  } catch { return []; }
}

(async () => {
  console.log(`\n========== AUDIT EXIT-EDGE TRADER — limit ${LIMIT} ==========\n`);
  const { data: positions }: any = await sb.from('lisa_positions')
    .select('id, symbol, direction, entry_price, exit_price, entry_timestamp, exit_timestamp, exit_reason, realized_pnl_pct, take_profit_price, stop_loss_price')
    .eq('portfolio_id', TRADER).neq('status', 'open')
    .order('entry_timestamp', { ascending: false }).limit(LIMIT);

  console.log(`Positions closed: ${positions?.length ?? 0}\n`);

  let analyzed = 0, skipNoData = 0;
  const byReason: Record<string, { n: number; sumRealizedPct: number; sumMfePct: number; missedTp15: number; missedTp20: number; sumMissedEdgePct: number }> = {};
  const details: any[] = [];

  for (const p of positions ?? []) {
    if (!p.exit_timestamp || p.direction !== 'long') continue;
    const entryTs = new Date(p.entry_timestamp).getTime();
    const exitTs = new Date(p.exit_timestamp).getTime();
    const entry = Number(p.entry_price);
    const symbol = p.symbol;
    const fromTs = Math.floor((entryTs - 600_000) / 1000);
    const toTs = Math.floor((exitTs + 600_000) / 1000);
    const candles = await fetchCandles5m(symbol, fromTs, toTs);
    const hold = candles.filter((c) => c.ts >= entryTs && c.ts <= exitTs);
    if (hold.length === 0) { skipNoData++; continue; }

    const mfePrice = Math.max(...hold.map((c) => c.high));
    const mfePct = ((mfePrice - entry) / entry) * 100;
    const realizedPct = Number(p.realized_pnl_pct ?? 0);
    const reason = (p.exit_reason ?? '-').split(' ')[0].replace(/[[\]]/g, '').slice(0, 24);
    const tpPct = p.take_profit_price ? ((Number(p.take_profit_price) - entry) / entry) * 100 : 2.5;

    const r = byReason[reason] ??= { n: 0, sumRealizedPct: 0, sumMfePct: 0, missedTp15: 0, missedTp20: 0, sumMissedEdgePct: 0 };
    r.n++;
    r.sumRealizedPct += realizedPct;
    r.sumMfePct += mfePct;
    if (mfePct >= 1.5 && realizedPct < 1.5) r.missedTp15++;
    if (mfePct >= 2.0 && realizedPct < 2.0) r.missedTp20++;
    // Edge laissé = MFE - realized (seulement si MFE positif > realized)
    const missed = Math.max(0, mfePct - Math.max(0, realizedPct));
    r.sumMissedEdgePct += missed;

    details.push({ symbol, reason, entry_ts: p.entry_timestamp?.slice(11, 19), realizedPct: realizedPct.toFixed(2), mfePct: mfePct.toFixed(2), tpPct: tpPct.toFixed(1), missed: missed.toFixed(2) });
    analyzed++;
    await new Promise((res) => setTimeout(res, 60));
  }

  console.log(`Analyzed (long, with candles): ${analyzed}, skip no-data: ${skipNoData}\n`);

  console.log('━━━ EDGE LAISSÉ PAR EXIT_REASON ━━━');
  console.log('reason                    n   avg_realized  avg_MFE   missed≥1.5%  missed≥2.0%  avg_missed_edge');
  const sorted = Object.entries(byReason).sort((a, b) => b[1].n - a[1].n);
  let totN = 0, totMissed15 = 0, totMissed20 = 0, totMissedEdge = 0;
  for (const [reason, r] of sorted) {
    totN += r.n; totMissed15 += r.missedTp15; totMissed20 += r.missedTp20; totMissedEdge += r.sumMissedEdgePct;
    console.log(
      `${reason.padEnd(24)} ${String(r.n).padStart(3)}  ${(r.sumRealizedPct / r.n).toFixed(2).padStart(10)}%  ${(r.sumMfePct / r.n).toFixed(2).padStart(6)}%  ${String(r.missedTp15).padStart(9)}  ${String(r.missedTp20).padStart(10)}  ${(r.sumMissedEdgePct / r.n).toFixed(2).padStart(12)}%`,
    );
  }
  console.log(`\nTOTAL: ${totN} trades`);
  console.log(`  Positions MFE ≥ 1.5% mais exit < 1.5% : ${totMissed15} (${((totMissed15 / totN) * 100).toFixed(0)}%)`);
  console.log(`  Positions MFE ≥ 2.0% mais exit < 2.0% : ${totMissed20} (${((totMissed20 / totN) * 100).toFixed(0)}%)`);
  console.log(`  Edge moyen laissé sur la table : ${(totMissedEdge / totN).toFixed(2)}%/trade`);

  // Top 10 worst missed edge
  details.sort((a, b) => Number(b.missed) - Number(a.missed));
  console.log('\n━━━ TOP 10 EDGE LAISSÉ ━━━');
  for (const d of details.slice(0, 10)) {
    console.log(`  ${d.symbol.padEnd(12)} ${d.reason.padEnd(20)} realized=${d.realizedPct}% MFE=${d.mfePct}% (laissé ${d.missed}%)`);
  }

  const out = { generated_at: new Date().toISOString(), analyzed, by_reason: byReason, total_missed_15: totMissed15, total_missed_20: totMissed20, avg_missed_edge_pct: totMissedEdge / totN };
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(path.join('out', `exit-edge-audit-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`), JSON.stringify(out, null, 2));
  console.log(`\n✅ Output saved.\n`);
})();
