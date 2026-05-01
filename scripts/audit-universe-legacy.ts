/**
 * scripts/audit-universe-legacy.ts
 *
 * Génère docs/universe-legacy-snapshot.json depuis la table watchlist_universe
 * en DB et seed gainers_legacy_snapshot si vide.
 *
 * Usage :
 *   pnpm tsx scripts/audit-universe-legacy.ts [--apply]
 *
 * Sans --apply : dry-run (affiche le rapport, n'écrit pas en DB).
 * Avec --apply : seed gainers_legacy_snapshot + écrit le JSON.
 *
 * Prérequis : SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY dans .env.local
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const apply = process.argv.includes('--apply');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exit(1);
  }

  const supabase = createClient(url, key);

  // 1. Fetch watchlist_universe
  const { data: universes, error } = await supabase
    .from('watchlist_universe')
    .select('name, exchange, tickers');
  if (error) {
    console.error('Failed to fetch watchlist_universe:', error.message);
    process.exit(1);
  }

  const byExchange: Record<string, { asset_class: string; symbols: string[] }> = {};
  let totalSymbols = 0;

  for (const u of universes ?? []) {
    const isEquity = u.exchange !== 'BINANCE';
    const ex = u.exchange as string;
    if (!byExchange[ex]) {
      byExchange[ex] = { asset_class: isEquity ? 'equity' : 'crypto', symbols: [] };
    }
    const tickers = (u.tickers as string[]) ?? [];
    for (const t of tickers) {
      if (!byExchange[ex].symbols.includes(t)) {
        byExchange[ex].symbols.push(t);
        totalSymbols++;
      }
    }
  }

  // Sort symbols for determinism
  for (const ex of Object.keys(byExchange)) {
    byExchange[ex].symbols.sort();
  }

  const allSymbols = Object.values(byExchange).flatMap((e) => e.symbols).sort();
  const watchlistHash = createHash('sha256').update(allSymbols.join(',')).digest('hex');

  const snapshot = {
    generated_at: new Date().toISOString(),
    algo_version: 'v1',
    watchlist_hash: watchlistHash,
    exchanges: byExchange,
    total_symbols: totalSymbols,
  };

  console.log(`\n=== Universe Legacy Snapshot ===`);
  console.log(`Total symbols: ${totalSymbols}`);
  console.log(`Watchlist hash: ${watchlistHash}`);
  for (const [ex, data] of Object.entries(byExchange)) {
    console.log(`  ${ex} (${data.asset_class}): ${data.symbols.length} symbols`);
  }

  const outPath = path.join(__dirname, '..', 'docs', 'universe-legacy-snapshot.json');

  if (!apply) {
    console.log('\n[DRY RUN] No changes written. Pass --apply to seed DB and write JSON.');
    return;
  }

  // 2. Write JSON
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\nWrote ${outPath}`);

  // 3. Seed gainers_legacy_snapshot
  const rows = Object.entries(byExchange).flatMap(([exchange, data]) =>
    data.symbols.map((symbol) => ({
      symbol,
      exchange,
      asset_class: data.asset_class,
      watchlist_hash: watchlistHash,
      first_seen_at: new Date().toISOString(),
    })),
  );

  const { error: seedError, count } = await supabase
    .from('gainers_legacy_snapshot')
    .upsert(rows, { onConflict: 'symbol,exchange', count: 'estimated' });

  if (seedError) {
    console.error('Failed to seed gainers_legacy_snapshot:', seedError.message);
    process.exit(1);
  }

  console.log(`Seeded gainers_legacy_snapshot: ~${count ?? rows.length} rows`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
