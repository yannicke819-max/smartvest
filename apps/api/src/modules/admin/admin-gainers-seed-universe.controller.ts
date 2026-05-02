/**
 * POST /admin/gainers/seed-legacy-universe — extend gainers_legacy_snapshot
 * + (optionnel, default ON) baseline refresh ETL chaîné.
 *
 * Équivalent runtime de scripts/audit-universe-legacy.ts --apply, plus :
 * - Lit watchlist_universe, calcule SHA256 hash, upsert gainers_legacy_snapshot
 * - Si include_baseline_refresh=true (default) → chaîne POST baseline/refresh
 *   (calc median 20j + upsert gainers_volume_baselines + reload cache)
 *
 * Idempotent (ON CONFLICT DO NOTHING + ETL onConflict='symbol,exchange').
 *
 * Auth via x-admin-token.
 *
 * Query params :
 *   ?include_baseline_refresh=false  → skip baseline refresh chain
 *
 * Réponse :
 * {
 *   seed: {
 *     totalSymbols: 215, inserted: 200, skipped: 15,
 *     exchanges: { US: 200, BINANCE: 3, ... },
 *     watchlistHash: "sha256..."
 *   },
 *   baseline: {  // null si skip
 *     totalSymbols: 215, computed: 213, cacheHits: 198, cacheMisses: 12,
 *     liveFetchSuccess: 14, liveFetchFailures: 1,
 *     cacheStale: false, durationMs: 8523, cacheReloaded: true, cacheSize: 213
 *   },
 *   totalDurationMs: 9821
 * }
 */

import { Controller, Headers, HttpException, HttpStatus, Logger, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { VolumeBaselineCalculatorService } from '../gainers-scanner/bloc2/volume-baseline-calculator.service';
import { VolumeBaselineService } from '../gainers-scanner/bloc2/volume-baseline.service';

interface UniverseRow {
  exchange: string;
  tickers: string[] | null;
}

@Controller('admin/gainers/seed-legacy-universe')
export class AdminGainersSeedUniverseController {
  private readonly logger = new Logger(AdminGainersSeedUniverseController.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    private readonly calculator: VolumeBaselineCalculatorService,
    private readonly baseline: VolumeBaselineService,
  ) {}

  @Post()
  async seed(
    @Headers('x-admin-token') token: string | undefined,
    @Query('include_baseline_refresh') includeBaselineRefresh: string | undefined,
  ) {
    this.assertAdmin(token);
    const t0 = Date.now();
    const chainBaseline = includeBaselineRefresh !== 'false';

    // 1. Lit watchlist_universe
    const { data: universes, error: fetchErr } = await this.supabase
      .getClient()
      .from('watchlist_universe')
      .select('exchange, tickers');

    if (fetchErr) {
      this.logger.error(`fetch watchlist_universe failed: ${fetchErr.message}`);
      throw new HttpException(
        { message: `fetch watchlist_universe: ${fetchErr.message}`, code: 'FETCH_FAILED' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // 2. Aggrège par exchange + collecte tous symbols (uniques, triés)
    const byExchange: Record<string, { assetClass: 'equity' | 'crypto'; symbols: string[] }> = {};
    const allSymbolsSet = new Set<string>();

    for (const u of (universes ?? []) as UniverseRow[]) {
      const ex = u.exchange;
      const isCrypto = ex === 'BINANCE';
      if (!byExchange[ex]) {
        byExchange[ex] = { assetClass: isCrypto ? 'crypto' : 'equity', symbols: [] };
      }
      const tickers = u.tickers ?? [];
      for (const t of tickers) {
        if (!byExchange[ex].symbols.includes(t)) {
          byExchange[ex].symbols.push(t);
          allSymbolsSet.add(t);
        }
      }
    }

    for (const ex of Object.keys(byExchange)) {
      byExchange[ex].symbols.sort();
    }

    const allSorted = Array.from(allSymbolsSet).sort();
    const watchlistHash = createHash('sha256').update(allSorted.join(',')).digest('hex');

    // 3. Construit les rows à upsert (idempotent via ON CONFLICT DO NOTHING)
    const rows = Object.entries(byExchange).flatMap(([exchange, data]) =>
      data.symbols.map((symbol) => ({
        symbol,
        exchange,
        asset_class: data.assetClass,
        watchlist_hash: watchlistHash,
      })),
    );

    if (rows.length === 0) {
      return {
        seed: {
          totalSymbols: 0,
          inserted: 0,
          skipped: 0,
          exchanges: {},
          watchlistHash,
          message: 'watchlist_universe vide — rien à seed',
        },
        baseline: null,
        totalDurationMs: Date.now() - t0,
      };
    }

    // Count avant pour calculer "inserted" précisément
    const { count: beforeCount } = await this.supabase
      .getClient()
      .from('gainers_legacy_snapshot')
      .select('*', { count: 'exact', head: true });

    // 4. Upsert avec ON CONFLICT DO NOTHING (matches le script TS)
    const { error: upsertErr } = await this.supabase
      .getClient()
      .from('gainers_legacy_snapshot')
      .upsert(rows, { onConflict: 'symbol,exchange', ignoreDuplicates: true });

    if (upsertErr) {
      this.logger.error(`upsert gainers_legacy_snapshot failed: ${upsertErr.message}`);
      throw new HttpException(
        { message: `upsert: ${upsertErr.message}`, code: 'UPSERT_FAILED' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // Count après pour delta
    const { count: afterCount } = await this.supabase
      .getClient()
      .from('gainers_legacy_snapshot')
      .select('*', { count: 'exact', head: true });

    const inserted = (afterCount ?? 0) - (beforeCount ?? 0);
    const skipped = rows.length - inserted;

    const exchanges = Object.fromEntries(
      Object.entries(byExchange).map(([ex, d]) => [ex, d.symbols.length]),
    );

    this.logger.log(
      `[seed-legacy-universe] total=${rows.length} inserted=${inserted} skipped=${skipped} hash=${watchlistHash.slice(0, 8)}…`,
    );

    const seedResult = {
      totalSymbols: rows.length,
      inserted,
      skipped,
      exchanges,
      watchlistHash,
    };

    // 5. Chain baseline refresh ETL si demandé (default ON)
    let baselineResult: any = null;
    if (chainBaseline) {
      try {
        this.logger.log('[seed-legacy-universe] chaining baseline refresh ETL…');
        baselineResult = await this.calculator.runEtl();
        await this.baseline.reloadCache();
        baselineResult = {
          ...baselineResult,
          cacheReloaded: true,
          cacheSize: this.baseline.cacheSize,
        };
      } catch (e) {
        this.logger.warn(`[seed-legacy-universe] baseline refresh failed: ${String(e).slice(0, 120)}`);
        baselineResult = {
          error: String(e).slice(0, 200),
          message: 'baseline ETL failed — seed succeeded, run baseline/refresh manuellement',
        };
      }
    }

    return {
      seed: seedResult,
      baseline: baselineResult,
      totalDurationMs: Date.now() - t0,
    };
  }

  private assertAdmin(providedToken: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || expected.length === 0) {
      throw new HttpException(
        { message: 'Endpoint disabled (ADMIN_TOKEN not configured)', code: 'ADMIN_DISABLED' },
        HttpStatus.FORBIDDEN,
      );
    }
    if (providedToken !== expected) {
      throw new HttpException(
        { message: 'Invalid admin token', code: 'ADMIN_FORBIDDEN' },
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
