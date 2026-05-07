import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';

/**
 * PR Wizard.1 — DB-backed feature flags pour les LIVE-related.
 *
 * Permet de flipper BROKER_EXECUTION_ENABLED + 4 autres flags LIVE depuis
 * l'UI wizard au lieu de `flyctl secrets set` (CLI). Lecture priorité :
 *   1. live_feature_flags (DB) si row existe ET enabled=true
 *   2. env var Fly (fallback)
 *
 * Convention de sécurité (immuable) :
 *   - AUTONOMY_KILL_SWITCH garde la précédence env (kill-switch d'urgence
 *     reste sur Fly secret pour ne JAMAIS dépendre de la DB)
 *   - Pour les flags d'AUTORISATION (EXECUTION/AUTONOMOUS) : env=true →
 *     toujours respecté (admin override). DB=true autorise SI env != "false"
 *     explicit.
 *
 * Cache in-memory 30s pour ne pas hitter la DB à chaque check de flag.
 *
 * En cas de désynchro DB ↔ env : env gagne (sécurité par défaut).
 */

const CACHED_FLAGS = new Set([
  'BROKER_EXECUTION_ENABLED',
  'DELEGATION_AUTONOMOUS_GUARDED',
  'BROKER_RECONCILIATION_ENABLED',
  'BROKER_ADAPTER_IB_ENABLED',
  'BROKER_ADAPTER_BINANCE_ENABLED',
]);

type LiveFlagKey = typeof CACHED_FLAGS extends Set<infer T> ? T : never;

interface DbFlagRow {
  flag_key: string;
  enabled: boolean;
  set_via: 'env' | 'wizard' | 'admin' | 'kill_switch_revert';
  set_by_user_id: string | null;
  reason: string | null;
  updated_at: string;
}

@Injectable()
export class LiveFeatureFlagsService implements OnModuleInit {
  private readonly logger = new Logger(LiveFeatureFlagsService.name);
  private cache: Map<string, boolean> = new Map();
  private cacheAsOf = 0;
  private readonly CACHE_TTL_MS = 30_000;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly envFlags: FeatureFlagsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Pré-warm le cache au démarrage pour éviter race avec les premières
    // requêtes (cold start).
    await this.refreshCache().catch(() => undefined);
  }

  /**
   * Lecture d'un flag avec précédence DB > env. Cache 30s.
   *
   * Comportement :
   *   - Si AUTONOMY_KILL_SWITCH=true en env → return false pour tous les
   *     flags d'autorisation (sécurité d'urgence)
   *   - Sinon : DB enabled=true OU env enabled=true → return true
   */
  async isEnabled(flagKey: LiveFlagKey): Promise<boolean> {
    // Kill-switch global propage immédiatement (pas de cache pour ça)
    if (this.envFlags.getAll().AUTONOMY_KILL_SWITCH) {
      return false;
    }

    await this.refreshCacheIfStale();
    const dbValue = this.cache.get(flagKey);
    const envFlagsAll = this.envFlags.getAll() as unknown as Record<string, boolean>;
    const envValue = envFlagsAll[flagKey] ?? false;

    // Convention : DB peut activer si env=false (wizard prend le relais)
    // Mais env=true override DB=false (admin peut désactiver via env si urgence)
    return dbValue === true || envValue === true;
  }

  /**
   * Wizard helper : flip un flag DB-backed. Audit + cache invalidation.
   * Appelé uniquement depuis WizardController avec validation des conditions.
   *
   * Throws si essai d'override de kill-switch (pas géré ici par design).
   */
  async setFlag(
    flagKey: LiveFlagKey,
    enabled: boolean,
    userId: string,
    reason: string,
    setVia: 'wizard' | 'admin' | 'kill_switch_revert' = 'wizard',
  ): Promise<void> {
    const { error } = await this.supabase
      .getClient()
      .from('live_feature_flags')
      .upsert(
        {
          flag_key: flagKey,
          enabled,
          set_by_user_id: userId,
          set_via: setVia,
          reason,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'flag_key' },
      );
    if (error) {
      this.logger.error(`[live-flags] setFlag ${flagKey}=${enabled} failed: ${error.message}`);
      throw new Error(`Failed to set flag ${flagKey}: ${error.message}`);
    }
    this.invalidateCache();
    this.logger.log(`[live-flags] ${flagKey}=${enabled} (via=${setVia}, user=${userId.slice(0, 8)}, reason="${reason}")`);
  }

  /**
   * Lit l'état complet de tous les flags DB-backed (pour UI dashboard).
   */
  async getAllStates(): Promise<Array<{
    flag_key: string;
    enabled_db: boolean | null;
    enabled_env: boolean;
    effective: boolean;
    last_set_at: string | null;
    set_via: string | null;
  }>> {
    const { data } = await this.supabase
      .getClient()
      .from('live_feature_flags')
      .select('flag_key, enabled, set_via, updated_at');

    const dbByKey = new Map<string, DbFlagRow>();
    for (const row of (data ?? []) as Partial<DbFlagRow>[]) {
      if (row.flag_key) {
        dbByKey.set(row.flag_key, row as DbFlagRow);
      }
    }

    const env = this.envFlags.getAll();
    const out: Array<{
      flag_key: string;
      enabled_db: boolean | null;
      enabled_env: boolean;
      effective: boolean;
      last_set_at: string | null;
      set_via: string | null;
    }> = [];
    for (const key of CACHED_FLAGS) {
      const dbRow = dbByKey.get(key);
      const envValue = env[key as keyof typeof env] ?? false;
      const effective = await this.isEnabled(key as LiveFlagKey);
      out.push({
        flag_key: key,
        enabled_db: dbRow ? dbRow.enabled : null,
        enabled_env: !!envValue,
        effective,
        last_set_at: dbRow?.updated_at ?? null,
        set_via: dbRow?.set_via ?? null,
      });
    }
    return out;
  }

  invalidateCache(): void {
    this.cacheAsOf = 0;
  }

  private async refreshCacheIfStale(): Promise<void> {
    if (Date.now() - this.cacheAsOf < this.CACHE_TTL_MS) return;
    await this.refreshCache();
  }

  private async refreshCache(): Promise<void> {
    try {
      const { data } = await this.supabase
        .getClient()
        .from('live_feature_flags')
        .select('flag_key, enabled');
      const newCache = new Map<string, boolean>();
      for (const row of (data ?? []) as Array<{ flag_key: string; enabled: boolean }>) {
        if (CACHED_FLAGS.has(row.flag_key as LiveFlagKey)) {
          newCache.set(row.flag_key, row.enabled);
        }
      }
      this.cache = newCache;
      this.cacheAsOf = Date.now();
    } catch (e) {
      this.logger.warn(`[live-flags] cache refresh failed (using stale): ${String(e).slice(0, 80)}`);
    }
  }
}
