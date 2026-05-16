import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * Phase 5 N2 — lecture du notional Kelly par asset_class (`asset_class_kelly_config`).
 *
 * Pattern identique à AssetClassTpSlConfigService (PR #329) : cache in-memory,
 * TTL 60 s, reload async non-bloquant sur cache stale, fail-open total.
 *
 * Activation conditionnelle : `getNotionalUsd(class)` retourne `null` si
 *   - classe absente du cache OU
 *   - `kelly_fraction <= 0` (edge négatif / pas d activation) OU
 *   - `sample_size < 30` (échantillon insuffisant, ADR-007 §3.4)
 *
 * `null` = caller doit fallback au notional uniforme historique.
 */

export interface KellyConfigRow {
  asset_class: string;
  notional_usd: number;
  kelly_fraction: number;
  sample_size: number;
}

const MIN_SAMPLE_SIZE = 30;

@Injectable()
export class AssetClassKellyConfigService implements OnModuleInit {
  private readonly logger = new Logger(AssetClassKellyConfigService.name);
  private readonly cache = new Map<string, KellyConfigRow>();
  private lastLoadAt: Date | null = null;
  private readonly CACHE_TTL_MS = 60_000;
  private inflightReload: Promise<void> | null = null;

  constructor(private readonly supabase: SupabaseService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /** Force reload synchrone. Visible pour tests + bootstrap. */
  async reload(): Promise<void> {
    if (!this.supabase.isReady()) {
      this.logger.warn('[Kelly] Supabase not ready — config reload skipped');
      return;
    }
    try {
      const { data, error } = await this.supabase
        .getClient()
        .from('asset_class_kelly_config')
        .select('asset_class, notional_usd, kelly_fraction, sample_size');
      if (error) throw error;
      if (!data || data.length === 0) {
        this.logger.warn('[Kelly] asset_class_kelly_config returned empty — keeping previous cache');
        this.lastLoadAt = new Date();
        return;
      }
      this.cache.clear();
      for (const row of data as Array<Record<string, unknown>>) {
        const ac = String(row.asset_class);
        const notional = Number(row.notional_usd);
        const fraction = Number(row.kelly_fraction);
        const sample = Number(row.sample_size);
        if (!ac || !Number.isFinite(notional) || !Number.isFinite(fraction) || !Number.isFinite(sample)) continue;
        this.cache.set(ac, {
          asset_class: ac,
          notional_usd: notional,
          kelly_fraction: fraction,
          sample_size: sample,
        });
      }
      this.lastLoadAt = new Date();
      this.logger.log(`[Kelly] config loaded: ${this.cache.size} classes`);
    } catch (err) {
      this.logger.error(
        `[Kelly] config reload failed (${(err as Error).message}) — keeping previous cache (fail-open)`,
      );
    }
  }

  private isStale(): boolean {
    if (!this.lastLoadAt) return true;
    return Date.now() - this.lastLoadAt.getTime() > this.CACHE_TTL_MS;
  }

  private triggerStaleReload(): void {
    if (this.inflightReload) return;
    this.inflightReload = this.reload().finally(() => {
      this.inflightReload = null;
    });
  }

  /**
   * Retourne le notional Kelly recommandé (USD) si la classe est activée :
   *   - présente en cache ET
   *   - `kelly_fraction > 0` (edge positif détecté) ET
   *   - `sample_size >= 30` (échantillon suffisant).
   *
   * Retourne `null` sinon : le caller doit fallback au notional uniforme.
   * Trigger reload async si cache stale (n attend pas le résultat).
   */
  getNotionalUsd(assetClass: string): number | null {
    if (this.isStale()) this.triggerStaleReload();
    const row = this.cache.get(assetClass);
    if (!row) return null;
    if (row.kelly_fraction <= 0) return null;
    if (row.sample_size < MIN_SAMPLE_SIZE) return null;
    return row.notional_usd;
  }

  /** Visible pour debug / admin endpoint éventuel. */
  getCacheSnapshot(): KellyConfigRow[] {
    return Array.from(this.cache.values());
  }
}
