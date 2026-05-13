/**
 * SHORT-SHADOW Phase 2 — Rétroactif rigoureux sur 147 mesurables small/mid US (07/05/2026).
 *
 * Objectif :
 *   Re-simuler les 147 signaux US small/mid de la journée 07/05/2026 avec direction='short'
 *   sur les 6 grilles SHORT, puis comparer expectancy vs hypothèse Phase 2 (>+0.5% ?).
 *
 * Méthodologie :
 *   1. SELECT 147 mesurables (TP_HIT ou SL_HIT en baseline_60m LONG) du 07/05/2026
 *   2. Pour chaque row, re-fetch candles EODHD 5m autour de createdAt (fenêtre +65min)
 *   3. Run walkForward direction='short' sur les 6 grilles SHORT (4 mirror + 2 calibrated)
 *   4. Output : phase2-retro-results.json (raw) + aggregated stats console
 *   5. Verdict GO/STOP Phase 3 sur critères (expectancy >+0.5% ET WR ≥50% ET IC95 lo >40%)
 *
 * NO DB WRITES (read-only). Standalone, indépendant du runtime NestJS.
 *
 * Usage :
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   EODHD_API_KEY=xxx \
 *   ./node_modules/.bin/ts-node scripts/phase2-short-retro.ts
 *
 * Output local (non commité) : phase2-retro-results.json
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import {
  walkForward,
  getGridsForAssetClass,
  type CandleLike,
} from '../apps/api/src/modules/lisa/services/gainers-user-shadow.service';

// ───────────────────────── EODHD client minimal ─────────────────────────

async function fetchEodhdCandles(
  symbol: string,
  fromTs: number,
  toTs: number,
  apiKey: string,
): Promise<CandleLike[] | null> {
  const url =
    `https://eodhd.com/api/intraday/${encodeURIComponent(symbol)}` +
    `?api_token=${apiKey}&interval=5m&fmt=json&from=${fromTs}&to=${toTs}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`  [eodhd] HTTP ${res.status} for ${symbol}`);
      return null;
    }
    const data = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(data) || data.length === 0) return null;
    return data
      .map((d) => {
        let ts = Number(d.timestamp ?? 0);
        if (ts > 1e12) ts = Math.floor(ts / 1000);
        return {
          timestamp: ts,
          high: Number(d.high ?? 0),
          low: Number(d.low ?? 0),
          close: Number(d.close ?? 0),
        };
      })
      .filter(
        (c) =>
          Number.isFinite(c.timestamp) &&
          Number.isFinite(c.close) &&
          c.close > 0,
      )
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch (e) {
    console.error(`  [eodhd] fetch error for ${symbol}:`, e);
    return null;
  }
}

// ───────────────────────── Wilson IC95 ─────────────────────────

function wilson95(wins: number, n: number): { lo: number; mid: number; hi: number } {
  if (n === 0) return { lo: 0, mid: 0, hi: 0 };
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - margin), mid: p, hi: Math.min(1, center + margin) };
}

// ───────────────────────── Types ─────────────────────────

type SimResults = {
  baseline_30m?: { outcome: string; pnl_pct: number | null };
  baseline_60m?: { outcome: string; pnl_pct: number | null };
  alt15_30m?: { outcome: string; pnl_pct: number | null };
  alt15_60m?: { outcome: string; pnl_pct: number | null };
};

type ResultRow = {
  signal_id: string;
  symbol: string;
  entry_price: number;
  created_at: string;
  grid: string;
  outcome: string;
  pnl_pct: number | null;
  hit_at_min: number | null;
  exit_price: number | null;
};

// ───────────────────────── Main ─────────────────────────

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const eodhdKey = process.env.EODHD_API_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    process.exit(1);
  }
  if (!eodhdKey) {
    console.error(
      'Missing EODHD_API_KEY env var (needed for candle re-fetch; fetch_diag stores no raw candles)',
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log('[phase2-retro] Loading small/mid US rows from 7 mai 2026 (UTC)...');
  const { data: rows, error } = await supabase
    .from('gainers_user_shadow_signals')
    .select('id, symbol, asset_class, entry_price, created_at, sim_results')
    .eq('asset_class', 'us_equity_small_mid')
    .gte('created_at', '2026-05-07T00:00:00Z')
    .lt('created_at', '2026-05-08T00:00:00Z')
    .not('sim_results', 'is', null);

  if (error) {
    console.error('[phase2-retro] Supabase query error:', error.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.warn('[phase2-retro] 0 rows loaded — nothing to simulate');
    process.exit(0);
  }
  console.log(`[phase2-retro] Loaded ${rows.length} rows from DB`);

  // Filter to mesurables : baseline_60m a TP_HIT ou SL_HIT (definition utilisateur n=147)
  const mesurables = rows.filter((r) => {
    const sim = r.sim_results as SimResults | null;
    const outcome = sim?.baseline_60m?.outcome;
    return outcome === 'TP_HIT' || outcome === 'SL_HIT';
  });
  console.log(
    `[phase2-retro] ${mesurables.length} mesurables (TP_HIT/SL_HIT en baseline_60m LONG)`,
  );

  // 6 SHORT grids (us_equity_small_mid retourne 4 LONG + 6 SHORT)
  const allGrids = getGridsForAssetClass('us_equity_small_mid');
  const shortGrids = allGrids.filter((g) => g.direction === 'short');
  console.log(`[phase2-retro] Re-simulating with ${shortGrids.length} SHORT grids:`);
  for (const g of shortGrids) {
    console.log(
      `  - ${g.key.padEnd(28)} TP=${(g.tpPct * 100).toFixed(2)}% SL=${(g.slPct * 100).toFixed(2)}% window=${g.windowMin}min`,
    );
  }

  const results: ResultRow[] = [];
  let fetchFailures = 0;

  for (let i = 0; i < mesurables.length; i++) {
    const row = mesurables[i];
    if (row.entry_price == null) {
      console.warn(`\n[phase2-retro] Skip row ${row.id}: missing entry_price`);
      continue;
    }
    const startTs = Math.floor(new Date(row.created_at).getTime() / 1000);
    const fromTs = startTs - 300;
    const toTs = startTs + 60 * 60 + 300;

    process.stdout.write(
      `\r[phase2-retro] ${(i + 1).toString().padStart(3)}/${mesurables.length} ${row.symbol.padEnd(12)}`,
    );

    const candles = await fetchEodhdCandles(row.symbol, fromTs, toTs, eodhdKey);
    if (!candles || candles.length === 0) {
      fetchFailures++;
      for (const grid of shortGrids) {
        results.push({
          signal_id: row.id,
          symbol: row.symbol,
          entry_price: Number(row.entry_price),
          created_at: row.created_at,
          grid: grid.key,
          outcome: 'NO_DATA_FETCH_FAILED',
          pnl_pct: null,
          hit_at_min: null,
          exit_price: null,
        });
      }
      // Rate limit polite
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }

    for (const grid of shortGrids) {
      const out = walkForward(Number(row.entry_price), candles, startTs, grid);
      results.push({
        signal_id: row.id,
        symbol: row.symbol,
        entry_price: Number(row.entry_price),
        created_at: row.created_at,
        grid: grid.key,
        outcome: out.outcome,
        pnl_pct: out.pnl_pct,
        hit_at_min: out.hit_at_min,
        exit_price: out.exit_price,
      });
    }

    // Rate limit polite (10 req/s, well under EODHD plan limits)
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`\n[phase2-retro] All ${mesurables.length} rows processed.`);
  if (fetchFailures > 0) {
    console.warn(`[phase2-retro] ${fetchFailures} fetch failures (NO_DATA_FETCH_FAILED rows)`);
  }

  // Write raw results
  const outputPath = 'phase2-retro-results.json';
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`[phase2-retro] Raw results written to ${outputPath} (${results.length} rows)`);

  // ───────────────────────── Aggregate per grid ─────────────────────────

  console.log('\n========== PHASE 2 — Aggregated stats per SHORT grid ==========\n');

  type GridStats = {
    grid: string;
    n: number;
    wins: number;
    losses: number;
    timeLimit: number;
    wr: number;
    wrLo: number;
    wrHi: number;
    expectancy: number;
    stddev: number;
  };
  const gridStats: GridStats[] = [];

  for (const grid of shortGrids) {
    const gridResults = results.filter((r) => r.grid === grid.key);
    const measurable = gridResults.filter(
      (r) =>
        ['TP_HIT', 'SL_HIT', 'TIME_LIMIT'].includes(r.outcome) && r.pnl_pct !== null,
    );
    if (measurable.length === 0) {
      console.log(`${grid.key.padEnd(28)} 0 mesurables`);
      gridStats.push({
        grid: grid.key,
        n: 0,
        wins: 0,
        losses: 0,
        timeLimit: 0,
        wr: 0,
        wrLo: 0,
        wrHi: 0,
        expectancy: 0,
        stddev: 0,
      });
      continue;
    }
    const wins = measurable.filter((r) => (r.pnl_pct ?? 0) > 0).length;
    const losses = measurable.filter((r) => (r.pnl_pct ?? 0) <= 0).length;
    const timeLimit = measurable.filter((r) => r.outcome === 'TIME_LIMIT').length;
    const avgPnl =
      measurable.reduce((s, r) => s + (r.pnl_pct ?? 0), 0) / measurable.length;
    const variance =
      measurable.reduce((s, r) => s + Math.pow((r.pnl_pct ?? 0) - avgPnl, 2), 0) /
      measurable.length;
    const stddev = Math.sqrt(variance);
    const wilson = wilson95(wins, measurable.length);

    gridStats.push({
      grid: grid.key,
      n: measurable.length,
      wins,
      losses,
      timeLimit,
      wr: wilson.mid,
      wrLo: wilson.lo,
      wrHi: wilson.hi,
      expectancy: avgPnl,
      stddev,
    });

    console.log(
      `${grid.key.padEnd(28)} ` +
        `n=${String(measurable.length).padStart(3)} ` +
        `W/L=${String(wins).padStart(3)}/${String(losses).padStart(3)} ` +
        `(${String(timeLimit).padStart(3)} TIME) ` +
        `WR=${(wilson.mid * 100).toFixed(1)}% [${(wilson.lo * 100).toFixed(1)}, ${(wilson.hi * 100).toFixed(1)}] ` +
        `E[pnl]=${(avgPnl * 100).toFixed(3)}% σ=${(stddev * 100).toFixed(3)}%`,
    );
  }

  // ───────────────────────── Decision verdict ─────────────────────────

  console.log('\n========== DECISION (Phase 2 → Phase 3) ==========\n');
  console.log('Critères GO Phase 3 :');
  console.log('  - expectancy nette > +0.5%/trade');
  console.log('  - WR ≥ 50% (point estimate)');
  console.log('  - IC95 Wilson lower bound > 40% (robustesse à n=147)\n');

  const THRESHOLD_EXPECTANCY = 0.005;
  const THRESHOLD_WR = 0.5;
  const THRESHOLD_WR_LO = 0.4;

  const passing = gridStats.filter(
    (s) =>
      s.expectancy > THRESHOLD_EXPECTANCY &&
      s.wr >= THRESHOLD_WR &&
      s.wrLo > THRESHOLD_WR_LO,
  );

  if (passing.length > 0) {
    console.log(`✅ GO Phase 3 : ${passing.length} grille(s) SHORT passe(nt) TOUS les seuils :`);
    for (const p of passing) {
      console.log(
        `   - ${p.grid.padEnd(28)} ` +
          `WR=${(p.wr * 100).toFixed(1)}% (IC95 lo=${(p.wrLo * 100).toFixed(1)}%) ` +
          `expectancy=${(p.expectancy * 100).toFixed(3)}% n=${p.n}`,
      );
    }
    console.log('\nProchaine étape : revue diff, push branche, deploy MESURE-only, shadow 14j forward.');
  } else {
    console.log('❌ STOP : aucune grille SHORT ne passe les seuils.');
    console.log('Documentation échec à compléter, pas de deploy Phase 3.\n');
    console.log('Détail des grilles qui se sont approchées :');
    const sorted = [...gridStats].sort((a, b) => b.expectancy - a.expectancy);
    for (const s of sorted.slice(0, 3)) {
      const failExp = s.expectancy <= THRESHOLD_EXPECTANCY ? '❌ exp' : '✅ exp';
      const failWr = s.wr < THRESHOLD_WR ? '❌ WR' : '✅ WR';
      const failWrLo = s.wrLo <= THRESHOLD_WR_LO ? '❌ IC' : '✅ IC';
      console.log(
        `   - ${s.grid.padEnd(28)} ${failExp} ${failWr} ${failWrLo} | ` +
          `WR=${(s.wr * 100).toFixed(1)}% lo=${(s.wrLo * 100).toFixed(1)}% exp=${(s.expectancy * 100).toFixed(3)}%`,
      );
    }
  }

  console.log('\n[phase2-retro] Done.');
}

main().catch((e) => {
  console.error('[phase2-retro] FATAL:', e);
  process.exit(1);
});
