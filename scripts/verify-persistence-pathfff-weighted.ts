/**
 * verify-persistence-pathfff-weighted.ts
 *
 * Analyse quantitative pondérée des seuils `persistence_score` et `path_efficiency`
 * du scanner Gainers SmartVest, ventilée par classe d'actifs et par tranche horaire UTC.
 *
 * Sources de données :
 *   A. `lisa_positions` (status != 'open')  + `path_eff_at_entry` + `persistence_score_at_entry`
 *      → trades RÉELLEMENT ouverts (sample mince mais réel)
 *   B. `gainers_user_shadow_signals` (sim_results JSONB)
 *      → simulation TP/SL post-hoc (sample large, inclut accept + rejets)
 *
 * Pour chaque classe (us_equity_large, us_equity_small_mid, eu_equity, asia_equity,
 * crypto_major, crypto_alt) on calcule :
 *   - distribution par bucket persistence (0, 0.17, 0.33, 0.5, 0.67, 0.83, 1.0)
 *   - distribution par bucket path_eff   (<0.2, 0.2-0.3, 0.3-0.4, 0.4-0.5, 0.5-0.7, 0.7+)
 *   - matrice persistence × path_eff
 *   - répartition horaire UTC
 *   - simulation : combien de trades / PnL si on baisse / monte le seuil ?
 *
 * Usage : pnpm tsx scripts/verify-persistence-pathfff-weighted.ts [--days 30]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const DAYS = parseInt(
  process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ??
    (process.argv.includes('--days') ? process.argv[process.argv.indexOf('--days') + 1] : '30'),
  10,
);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const CLASSES = [
  'us_equity_large',
  'us_equity_small_mid',
  'eu_equity',
  'asia_equity',
  'crypto_major',
  'crypto_alt',
] as const;

const PERSISTENCE_BUCKETS = [0, 0.17, 0.33, 0.5, 0.67, 0.83, 1.01];
const PATH_EFF_BUCKETS = [0, 0.2, 0.3, 0.4, 0.5, 0.7, 1.01];
const HOUR_BUCKETS = [0, 4, 8, 12, 16, 20, 24];

function bucketIdx(value: number, buckets: number[]): number {
  for (let i = 0; i < buckets.length - 1; i++) {
    if (value >= buckets[i] && value < buckets[i + 1]) return i;
  }
  return buckets.length - 2;
}

function bucketLabel(idx: number, buckets: number[]): string {
  return `[${buckets[idx].toFixed(2)}, ${buckets[idx + 1].toFixed(2)})`;
}

type TradeStat = {
  asset_class: string;
  persistence: number | null;
  path_eff: number | null;
  pnl_pct: number;
  is_win: boolean;
  hour_utc: number;
  source: 'real' | 'sim_baseline_60m' | 'sim_alt15_60m';
};

async function fetchLisaPositions(): Promise<TradeStat[]> {
  const sinceIso = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('lisa_positions')
    .select(
      'asset_class, status, path_eff_at_entry, persistence_score_at_entry, realized_pnl_pct, entry_timestamp, exit_timestamp',
    )
    .gte('entry_timestamp', sinceIso)
    .neq('status', 'open')
    .not('realized_pnl_pct', 'is', null);
  if (error) {
    console.warn('[lisa_positions]', error.message);
    return [];
  }
  return (data ?? [])
    .filter((r) => r.realized_pnl_pct != null)
    .map((r) => ({
      asset_class: String(r.asset_class ?? 'unknown'),
      persistence: r.persistence_score_at_entry != null ? Number(r.persistence_score_at_entry) : null,
      path_eff: r.path_eff_at_entry != null ? Number(r.path_eff_at_entry) : null,
      pnl_pct: Number(r.realized_pnl_pct),
      is_win: Number(r.realized_pnl_pct) > 0,
      hour_utc: new Date(r.entry_timestamp).getUTCHours(),
      source: 'real' as const,
    }));
}

async function fetchUserShadowSignals(): Promise<TradeStat[]> {
  const sinceIso = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString();
  // pagination — supabase default cap 1000
  const allRows: any[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('gainers_user_shadow_signals')
      .select('asset_class, path_eff, persistence_score, sim_results, created_at, decision')
      .gte('created_at', sinceIso)
      .not('sim_results', 'is', null)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn('[gainers_user_shadow_signals]', error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
    if (from > 50_000) break; // safety cap
  }

  const out: TradeStat[] = [];
  for (const r of allRows) {
    const sim = r.sim_results;
    if (!sim || typeof sim !== 'object') continue;
    const baseline = sim.baseline_60m;
    if (!baseline || baseline.outcome === 'NO_DATA' || baseline.pnl_pct == null) continue;
    out.push({
      asset_class: String(r.asset_class ?? 'unknown'),
      persistence: r.persistence_score != null ? Number(r.persistence_score) : null,
      path_eff: r.path_eff != null ? Number(r.path_eff) : null,
      pnl_pct: Number(baseline.pnl_pct),
      is_win: Number(baseline.pnl_pct) > 0,
      hour_utc: new Date(r.created_at).getUTCHours(),
      source: 'sim_baseline_60m',
    });
  }
  return out;
}

function agg(trades: TradeStat[]): { n: number; wr: number; sumPnl: number; avgPnl: number; expectancy: number } {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, sumPnl: 0, avgPnl: 0, expectancy: 0 };
  const wins = trades.filter((t) => t.is_win).length;
  const sumPnl = trades.reduce((s, t) => s + t.pnl_pct, 0);
  return {
    n,
    wr: wins / n,
    sumPnl,
    avgPnl: sumPnl / n,
    expectancy: sumPnl / n, // moy par trade en %
  };
}

function pct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}
function pp(v: number): string {
  return v.toFixed(2) + '%';
}
function num(v: number, d = 1): string {
  return v.toFixed(d);
}

function tableBucket(trades: TradeStat[], buckets: number[], getValue: (t: TradeStat) => number | null, label: string) {
  console.log(`\n  ${label}`);
  console.log(`  ${'bucket'.padEnd(16)} ${'n'.padStart(5)} ${'wr'.padStart(7)} ${'sumPnl'.padStart(9)} ${'avgPnl'.padStart(8)}`);
  for (let i = 0; i < buckets.length - 1; i++) {
    const bucket = trades.filter((t) => {
      const v = getValue(t);
      return v != null && v >= buckets[i] && v < buckets[i + 1];
    });
    const s = agg(bucket);
    if (s.n === 0) continue;
    console.log(
      `  ${bucketLabel(i, buckets).padEnd(16)} ${String(s.n).padStart(5)} ${pct(s.wr).padStart(7)} ${pp(s.sumPnl).padStart(9)} ${pp(s.avgPnl).padStart(8)}`,
    );
  }
}

function matrix(trades: TradeStat[]) {
  console.log(`\n  Matrice persistence × path_eff (n / wr / avgPnl) :`);
  const header = ['persist\\peff', ...PATH_EFF_BUCKETS.slice(0, -1).map((b, i) => `<${PATH_EFF_BUCKETS[i + 1].toFixed(2)}`)];
  console.log('  ' + header.map((h) => h.padEnd(14)).join(''));
  for (let pi = 0; pi < PERSISTENCE_BUCKETS.length - 1; pi++) {
    const row = [`p${PERSISTENCE_BUCKETS[pi].toFixed(2)}-${PERSISTENCE_BUCKETS[pi + 1].toFixed(2)}`];
    for (let ei = 0; ei < PATH_EFF_BUCKETS.length - 1; ei++) {
      const cell = trades.filter((t) => {
        if (t.persistence == null || t.path_eff == null) return false;
        return (
          t.persistence >= PERSISTENCE_BUCKETS[pi] &&
          t.persistence < PERSISTENCE_BUCKETS[pi + 1] &&
          t.path_eff >= PATH_EFF_BUCKETS[ei] &&
          t.path_eff < PATH_EFF_BUCKETS[ei + 1]
        );
      });
      const s = agg(cell);
      row.push(s.n === 0 ? '·' : `${s.n}/${pct(s.wr)}/${pp(s.avgPnl)}`);
    }
    console.log('  ' + row.map((c) => c.padEnd(14)).join(''));
  }
}

function thresholdSweep(trades: TradeStat[], getValue: (t: TradeStat) => number | null, label: string, sweep: number[]) {
  console.log(`\n  Sweep seuil ${label} (effet de RELÂCHER):`);
  console.log(`  ${'threshold'.padEnd(10)} ${'n_kept'.padStart(8)} ${'wr'.padStart(7)} ${'sumPnl'.padStart(9)} ${'avgPnl'.padStart(8)} ${'expectedDailyPnl(*)'.padStart(20)}`);
  const days = Math.max(DAYS, 1);
  for (const thr of sweep) {
    const kept = trades.filter((t) => {
      const v = getValue(t);
      return v != null && v >= thr;
    });
    const s = agg(kept);
    if (s.n === 0) {
      console.log(`  ${('≥' + thr.toFixed(2)).padEnd(10)} ${'0'.padStart(8)}`);
      continue;
    }
    const dailyPnlPct = s.sumPnl / days;
    console.log(
      `  ${('≥' + thr.toFixed(2)).padEnd(10)} ${String(s.n).padStart(8)} ${pct(s.wr).padStart(7)} ${pp(s.sumPnl).padStart(9)} ${pp(s.avgPnl).padStart(8)} ${pp(dailyPnlPct).padStart(20)}`,
    );
  }
  console.log(`  (*) daily PnL en % cumulé par trade — multiplier par position_size_pct pour USD`);
}

function hourly(trades: TradeStat[]) {
  console.log(`\n  Par tranche horaire UTC :`);
  console.log(`  ${'hour_bucket'.padEnd(14)} ${'n'.padStart(5)} ${'wr'.padStart(7)} ${'sumPnl'.padStart(9)} ${'avgPnl'.padStart(8)}`);
  for (let i = 0; i < HOUR_BUCKETS.length - 1; i++) {
    const bucket = trades.filter((t) => t.hour_utc >= HOUR_BUCKETS[i] && t.hour_utc < HOUR_BUCKETS[i + 1]);
    const s = agg(bucket);
    if (s.n === 0) continue;
    console.log(
      `  ${`${HOUR_BUCKETS[i]}-${HOUR_BUCKETS[i + 1]}h UTC`.padEnd(14)} ${String(s.n).padStart(5)} ${pct(s.wr).padStart(7)} ${pp(s.sumPnl).padStart(9)} ${pp(s.avgPnl).padStart(8)}`,
    );
  }
}

(async () => {
  console.log(`\n=== Verify persistence × path_eff weighted analysis (last ${DAYS}d) ===\n`);

  console.log('Fetching lisa_positions (real closed trades)...');
  const realTrades = await fetchLisaPositions();
  console.log(`  → ${realTrades.length} real closed trades`);

  console.log('Fetching gainers_user_shadow_signals (simulated TP/SL)...');
  const simTrades = await fetchUserShadowSignals();
  console.log(`  → ${simTrades.length} simulated outcomes (baseline 60m grid)`);

  const allTrades = [...realTrades, ...simTrades];
  console.log(`  → ${allTrades.length} total samples\n`);

  if (allTrades.length === 0) {
    console.log('NO DATA. Possibilités :');
    console.log('  - Aucun trade closed dans lisa_positions sur la fenêtre');
    console.log('  - Table gainers_user_shadow_signals vide (PR #280 pas en prod?)');
    console.log('  - Worker simulatePending pas exécuté → sim_results null');
    return;
  }

  // 1. Vue globale toutes classes
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('GLOBAL (toutes classes, toutes sources)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const g = agg(allTrades);
  console.log(`  n=${g.n} | winRate=${pct(g.wr)} | sumPnl=${pp(g.sumPnl)} | avgPnl=${pp(g.avgPnl)}`);
  tableBucket(allTrades, PERSISTENCE_BUCKETS, (t) => t.persistence, 'Distribution par persistence_score :');
  tableBucket(allTrades, PATH_EFF_BUCKETS, (t) => t.path_eff, 'Distribution par path_efficiency :');
  matrix(allTrades);
  thresholdSweep(allTrades, (t) => t.persistence, 'persistence_score', [0, 0.17, 0.33, 0.5, 0.67]);
  thresholdSweep(allTrades, (t) => t.path_eff, 'path_efficiency', [0, 0.1, 0.2, 0.3, 0.4, 0.5]);

  // 2. Par classe
  for (const cls of CLASSES) {
    const subset = allTrades.filter((t) => t.asset_class === cls);
    if (subset.length === 0) {
      console.log(`\n━━ ${cls.toUpperCase()} ━━ (n=0, skipped)`);
      continue;
    }
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`CLASSE: ${cls.toUpperCase()}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    const s = agg(subset);
    console.log(`  n=${s.n} | winRate=${pct(s.wr)} | sumPnl=${pp(s.sumPnl)} | avgPnl=${pp(s.avgPnl)} | daily_avg=${pp(s.sumPnl / DAYS)}`);
    tableBucket(subset, PERSISTENCE_BUCKETS, (t) => t.persistence, 'Persistence :');
    tableBucket(subset, PATH_EFF_BUCKETS, (t) => t.path_eff, 'Path efficiency :');
    thresholdSweep(subset, (t) => t.persistence, 'persistence', [0, 0.17, 0.33, 0.5, 0.67]);
    thresholdSweep(subset, (t) => t.path_eff, 'path_eff', [0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    hourly(subset);
  }

  // 3. Diagnostic source coverage par classe
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`COUVERTURE FEATURES par classe (% trades avec persistence + path_eff renseignés)`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${'classe'.padEnd(22)} ${'n_total'.padStart(8)} ${'n_with_pers'.padStart(12)} ${'n_with_peff'.padStart(12)} ${'n_with_both'.padStart(12)}`);
  for (const cls of CLASSES) {
    const subset = allTrades.filter((t) => t.asset_class === cls);
    const withPers = subset.filter((t) => t.persistence != null).length;
    const withPeff = subset.filter((t) => t.path_eff != null).length;
    const withBoth = subset.filter((t) => t.persistence != null && t.path_eff != null).length;
    console.log(`  ${cls.padEnd(22)} ${String(subset.length).padStart(8)} ${String(withPers).padStart(12)} ${String(withPeff).padStart(12)} ${String(withBoth).padStart(12)}`);
  }

  // 4. Verdict synthétique
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`VERDICT — sweet spots par classe`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  for (const cls of CLASSES) {
    const subset = allTrades.filter(
      (t) => t.asset_class === cls && t.persistence != null && t.path_eff != null,
    );
    if (subset.length < 10) {
      console.log(`  ${cls.padEnd(22)} → SAMPLE INSUFFISANT (n=${subset.length})`);
      continue;
    }
    // Pour chaque bucket peff, ratio expectancy/n permet de classer
    const candidates: { thr: number; n: number; wr: number; avgPnl: number; sumPnl: number; perDay: number }[] = [];
    for (const thr of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
      const kept = subset.filter((t) => (t.path_eff ?? 0) >= thr);
      const a = agg(kept);
      candidates.push({ thr, n: a.n, wr: a.wr, avgPnl: a.avgPnl, sumPnl: a.sumPnl, perDay: a.sumPnl / DAYS });
    }
    const best = candidates
      .filter((c) => c.n >= 5)
      .sort((a, b) => b.perDay - a.perDay)[0];
    if (best) {
      console.log(
        `  ${cls.padEnd(22)} → path_eff_min OPTIMAL = ${best.thr.toFixed(2)} ` +
          `(n=${best.n}, wr=${pct(best.wr)}, daily=${pp(best.perDay)})`,
      );
    }
  }

  console.log('\nFin.\n');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
