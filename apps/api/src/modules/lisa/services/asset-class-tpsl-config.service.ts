import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * PR-2 v2 — matrice TP/SL par asset_class (`asset_class_tpsl_config`).
 *
 * Lecture seule en runtime. Cache in-memory rafraîchi à intervalle TTL
 * (default 60 s). Reload async non-bloquant : un appel à `getTpPct`/`getSlPct`
 * sur cache stale renvoie immédiatement la valeur courante et déclenche un
 * reload en arrière-plan.
 *
 * Fail-open : si la query Supabase échoue (réseau / RLS / table absente),
 * le cache précédent est conservé et les callers fallback sur l'env legacy
 * via `?? null`. Aucune ouverture de position bloquée par un défaut de table.
 */

export interface TpSlConfigRow {
  asset_class: string;
  tp_pct: number;
  sl_pct: number;
}

@Injectable()
export class AssetClassTpSlConfigService implements OnModuleInit {
  private readonly logger = new Logger(AssetClassTpSlConfigService.name);
  private readonly cache = new Map<string, TpSlConfigRow>();
  private lastLoadAt: Date | null = null;
  private readonly CACHE_TTL_MS = 60_000;
  private inflightReload: Promise<void> | null = null;

  constructor(private readonly supabase: SupabaseService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /** Force reload synchrone. Visible pour les tests + bootstrap. */
  async reload(): Promise<void> {
    if (!this.supabase.isReady()) {
      this.logger.warn('Supabase not ready — TP/SL matrix reload skipped');
      return;
    }
    try {
      const { data, error } = await this.supabase
        .getClient()
        .from('asset_class_tpsl_config')
        .select('asset_class, tp_pct, sl_pct');
      if (error) throw error;
      if (!data || data.length === 0) {
        this.logger.warn('asset_class_tpsl_config returned empty — keeping previous cache');
        // On stamp quand même : évite un reload-storm sur table vide en
        // attendant le seed manuel ; le cache précédent reste utilisable.
        this.lastLoadAt = new Date();
        return;
      }
      this.cache.clear();
      for (const row of data as Array<Record<string, unknown>>) {
        const ac = String(row.asset_class);
        const tp = Number(row.tp_pct);
        const sl = Number(row.sl_pct);
        if (!ac || !Number.isFinite(tp) || !Number.isFinite(sl)) continue;
        this.cache.set(ac, { asset_class: ac, tp_pct: tp, sl_pct: sl });
      }
      this.lastLoadAt = new Date();
      this.logger.log(`TP/SL matrix loaded: ${this.cache.size} classes`);
    } catch (err) {
      this.logger.error(
        `TP/SL matrix reload failed (${(err as Error).message}) — keeping previous cache (fail-open)`,
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
   * Retourne tp_pct en décimal (0.030 = 3 %) pour la classe, ou null si absente.
   * Trigger reload async si stale (n'attend pas le résultat).
   */
  getTpPct(assetClass: string): number | null {
    if (this.isStale()) this.triggerStaleReload();
    return this.cache.get(assetClass)?.tp_pct ?? null;
  }

  /**
   * Retourne sl_pct en décimal négatif (-0.013 = -1.3 %), ou null si absente.
   */
  getSlPct(assetClass: string): number | null {
    if (this.isStale()) this.triggerStaleReload();
    return this.cache.get(assetClass)?.sl_pct ?? null;
  }

  /** Visible pour debug/admin endpoint éventuel. */
  getCacheSnapshot(): TpSlConfigRow[] {
    return Array.from(this.cache.values());
  }
}
