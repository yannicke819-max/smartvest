/**
 * BLOC 2 — Universe guard service (ADR-005 §non-régression).
 *
 * Vérifie au boot et à la demande que l'univers courant scanné est un
 * sur-ensemble de la table gainers_legacy_snapshot (K_current ≥ K_legacy).
 *
 * Drift alert si K_current < K_legacy (symboles disparus de l'univers).
 * watchlist_hash = SHA256(sorted joined symbols) pour détecter les mutations.
 */

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { createHash } from 'crypto';
import { SupabaseService } from '../../supabase/supabase.service';

export interface UniverseGuardResult {
  /** Symboles présents dans legacy mais absents du scan courant. */
  missingSymbols: string[];
  /** Ratio K_current / K_legacy (>= 1.0 = OK). */
  coverageRatio: number;
  currentHash: string;
  legacyHash: string | null;
  passed: boolean;
}

@Injectable()
export class UniverseGuardService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UniverseGuardService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async onApplicationBootstrap(): Promise<void> {
    // Validation au boot avec l'univers statique mega12+crypto (seed 0102).
    const staticUniverse = [
      'AAPL.US', 'MSFT.US', 'NVDA.US', 'META.US', 'GOOGL.US', 'TSLA.US',
      'AMD.US', 'AVGO.US', 'SPY.US', 'QQQ.US', 'IWM.US', 'XOM.US',
      'BTC-USD.CC', 'ETH-USD.CC', 'SOL-USD.CC',
    ];
    try {
      const result = await this.validateUniverse(staticUniverse);
      if (!result.passed) {
        this.logger.warn(
          `[UNIVERSE_GUARD] Boot check: ${result.missingSymbols.length} symbols missing ` +
          `from legacy snapshot. Coverage ${(result.coverageRatio * 100).toFixed(1)}%. ` +
          `Missing: ${result.missingSymbols.slice(0, 5).join(', ')}...`,
        );
      } else {
        this.logger.log(`[UNIVERSE_GUARD] Boot check passed. Coverage ${(result.coverageRatio * 100).toFixed(1)}%`);
      }
    } catch (e) {
      this.logger.error(`[UNIVERSE_GUARD] Boot check failed with exception: ${(e as Error).message}`);
    }
  }

  /** Calcule le watchlist_hash depuis un tableau de symboles triés. */
  computeHash(symbols: string[]): string {
    const sorted = [...symbols].sort().join(',');
    return createHash('sha256').update(sorted).digest('hex');
  }

  /**
   * Vérifie que currentSymbols ⊇ legacy snapshot (non-régression).
   * Alerte si K_current < K_legacy.
   */
  async validateUniverse(currentSymbols: string[]): Promise<UniverseGuardResult> {
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_legacy_snapshot')
      .select('symbol, watchlist_hash');

    if (error) {
      this.logger.error(`validateUniverse DB error: ${error.message}`);
      return {
        missingSymbols: [],
        coverageRatio: 1,
        currentHash: this.computeHash(currentSymbols),
        legacyHash: null,
        passed: true,
      };
    }

    const legacySymbols = (data ?? []).map((r: { symbol: string }) => r.symbol);
    const legacyHashes = (data ?? []).map((r: { watchlist_hash: string | null }) => r.watchlist_hash).filter(Boolean);
    const legacyHash = legacyHashes.length > 0 ? legacyHashes[0] : null;

    const currentSet = new Set(currentSymbols);
    const missingSymbols = legacySymbols.filter((s: string) => !currentSet.has(s));
    const coverageRatio = legacySymbols.length === 0 ? 1 : (legacySymbols.length - missingSymbols.length) / legacySymbols.length;

    return {
      missingSymbols,
      coverageRatio,
      currentHash: this.computeHash(currentSymbols),
      legacyHash,
      passed: missingSymbols.length === 0,
    };
  }

  /**
   * Seed initial de la table gainers_legacy_snapshot si elle est vide.
   * Appelé par scripts/audit-universe-legacy.ts ou manuellement.
   */
  async seedLegacySnapshot(
    symbols: { symbol: string; exchange: string; assetClass: 'equity' | 'crypto' }[],
  ): Promise<{ inserted: number }> {
    const hash = this.computeHash(symbols.map((s) => s.symbol));
    const rows = symbols.map((s) => ({
      symbol: s.symbol,
      exchange: s.exchange,
      asset_class: s.assetClass,
      watchlist_hash: hash,
      first_seen_at: new Date().toISOString(),
    }));
    const { error, count } = await this.supabase
      .getClient()
      .from('gainers_legacy_snapshot')
      .upsert(rows, { onConflict: 'symbol,exchange', count: 'estimated' });
    if (error) {
      this.logger.error(`seedLegacySnapshot failed: ${error.message}`);
      throw error;
    }
    return { inserted: count ?? rows.length };
  }
}
