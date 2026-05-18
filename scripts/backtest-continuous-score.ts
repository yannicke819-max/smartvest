/**
 * PR #351 — Backtest 14j scoring continu.
 *
 * Rejoue top_gainers_log avec calculateContinuousScore (sans calls réseau,
 * pure features). Compare virtual_opened vs reel + WR virtuel par classe.
 *
 * Limitations historiques :
 *   - momentum 5m/15m/30m → null (non reconstruisible depuis top_gainers_log,
 *     besoin de prix intraday cache historique). Le backtest est donc
 *     conservateur (momentum=0.5 neutre).
 *   - atrNormalized → null (idem).
 *
 * Usage :
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *   pnpm tsx scripts/backtest-continuous-score.ts
 *
 * Critères GO (cf. brief PR #351 §8) :
 *   - virtual_opened ≥ 25/jour
 *   - WR virtuel global ≥ 42%
 *   - aucune classe avec WR virtuel < 25%
 */

import { createClient } from '@supabase/supabase-js';
import {
  calculateContinuousScore,
  type ScoringAssetClass,
} from '@smartvest/ai-analyst';

const LOOKBACK_DAYS = 14;
const SCORING_ASSET_CLASSES: ReadonlySet<string> = new Set([
  'asia_equity',
  'eu_equity',
  'us_equity_large',
  'us_equity_small_mid',
  'crypto_major',
]);

interface ClassStats {
  opened: number;
  tp: number;
  sl: number;
  unknown: number;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  // 1. Logs scanner 14j
  const { data: candidates, error: candErr } = await supabase
    .from('top_gainers_log')
    .select(
      'symbol, detected_asset_class, market, change_pct, volume, avg_vol_50d, market_cap_usd, score, decision, captured_at',
    )
    .gte('captured_at', since)
    .limit(500_000);

  if (candErr) {
    console.error('Failed to load top_gainers_log:', candErr.message);
    process.exit(1);
  }
  if (!candidates || candidates.length === 0) {
    console.error('No candidates in lookback window');
    process.exit(1);
  }
  console.log(`Loaded ${candidates.length} top_gainers_log rows over ${LOOKBACK_DAYS}d`);

  // 2. Seuils par classe
  const { data: configs } = await supabase
    .from('asset_class_tpsl_config')
    .select('asset_class, continuous_score_floor');
  const floors = new Map<string, number>();
  configs?.forEach((c: { asset_class: string; continuous_score_floor: number | null }) => {
    floors.set(c.asset_class, c.continuous_score_floor ?? 60);
  });

  // 3. Outcomes réels (positions clôturées) — index par symbol_date pour rapprochement
  const { data: positions } = await supabase
    .from('lisa_positions')
    .select('symbol, asset_class, status, realized_pnl_usd, entry_timestamp')
    .gte('entry_timestamp', since)
    .in('status', ['closed_target', 'closed_stop']);

  const outcomeBySymbolDate = new Map<string, 'TP' | 'SL'>();
  positions?.forEach((p: { symbol: string; entry_timestamp: string; status: string }) => {
    const date = p.entry_timestamp.slice(0, 10);
    outcomeBySymbolDate.set(
      `${p.symbol}_${date}`,
      p.status === 'closed_target' ? 'TP' : 'SL',
    );
  });

  // 4. Backtest
  const stats: Record<string, ClassStats> = {};
  let skippedBadClass = 0;

  for (const c of candidates as Array<{
    symbol: string;
    detected_asset_class: string | null;
    market: string | null;
    change_pct: string | null;
    volume: string | null;
    avg_vol_50d: string | null;
    market_cap_usd: string | null;
    score: string | null;
    captured_at: string;
  }>) {
    const acRaw = c.detected_asset_class ?? c.market;
    if (!acRaw || !SCORING_ASSET_CLASSES.has(acRaw)) {
      skippedBadClass += 1;
      continue;
    }
    const ac = acRaw as ScoringAssetClass;

    const vol = Number(c.volume ?? 0);
    const avg = Number(c.avg_vol_50d ?? 0);
    const rvol = avg > 0 ? vol / avg : 0;

    const result = calculateContinuousScore(
      {
        changePctSnapshot: Number(c.change_pct ?? 0),
        rvol,
        marketCapUsd: c.market_cap_usd ? Number(c.market_cap_usd) : null,
        persistenceMultiTf: Number(c.score ?? 0),
        momentum5m: null, // non reconstructible
        momentum15m: null,
        momentum30m: null,
        atrNormalized: null,
      },
      ac,
    );

    const floor = floors.get(ac) ?? 60;
    if (result.total >= floor) {
      const slot = (stats[ac] ??= { opened: 0, tp: 0, sl: 0, unknown: 0 });
      slot.opened += 1;
      const outcome = outcomeBySymbolDate.get(`${c.symbol}_${c.captured_at.slice(0, 10)}`);
      if (outcome === 'TP') slot.tp += 1;
      else if (outcome === 'SL') slot.sl += 1;
      else slot.unknown += 1;
    }
  }

  // 5. Rapport
  console.log(`\n## Backtest ${LOOKBACK_DAYS}j PR #351\n`);
  console.log(`Skipped (bad/missing asset_class) : ${skippedBadClass}\n`);
  console.log('| Classe | Virtual Opened | TP | SL | Unknown | WR virtuel |');
  console.log('|---|---:|---:|---:|---:|---:|');

  let totalOpened = 0;
  let totalTp = 0;
  let totalSl = 0;
  for (const [ac, s] of Object.entries(stats)) {
    const closed = s.tp + s.sl;
    const wr = closed > 0 ? ((s.tp / closed) * 100).toFixed(1) : 'N/A';
    console.log(`| ${ac} | ${s.opened} | ${s.tp} | ${s.sl} | ${s.unknown} | ${wr}% |`);
    totalOpened += s.opened;
    totalTp += s.tp;
    totalSl += s.sl;
  }
  const totalClosed = totalTp + totalSl;
  const totalWrPct = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0;
  console.log(
    `| **TOTAL** | **${totalOpened}** | **${totalTp}** | **${totalSl}** | — | **${totalWrPct.toFixed(1)}%** |`,
  );

  const opensPerDay = totalOpened / LOOKBACK_DAYS;
  console.log(`\nVirtual opened/jour : ${opensPerDay.toFixed(1)} (cible ≥25)`);
  console.log(`WR virtuel global : ${totalWrPct.toFixed(1)}% (cible ≥42%)`);

  // 6. Critères GO
  const allClassesAbove25 = Object.values(stats).every((s) => {
    const closed = s.tp + s.sl;
    return closed === 0 || (s.tp / closed) * 100 >= 25;
  });

  console.log('\n## Critères GO');
  console.log(`- Volume ≥25/j : ${opensPerDay >= 25 ? 'OK' : 'KO'} (${opensPerDay.toFixed(1)})`);
  console.log(`- WR ≥42% : ${totalWrPct >= 42 ? 'OK' : 'KO'} (${totalWrPct.toFixed(1)}%)`);
  console.log(`- Toutes classes WR ≥25% : ${allClassesAbove25 ? 'OK' : 'KO'}`);
  const verdict =
    opensPerDay >= 25 && totalWrPct >= 42 && allClassesAbove25 ? '**GO**' : '**NO_GO**';
  console.log(`\nVerdict : ${verdict}`);
}

main().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
