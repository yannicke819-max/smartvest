/**
 * AdaptiveCooldownService — Feature #4.
 *
 * Maintient une Map<symbol, cooldownMin> dérivée de l'historique 30j des trades.
 * Refresh hebdomadaire (cron Sunday 03:00 UTC) + au boot.
 *
 * Exposé via getCooldownForSymbol(symbol, fallbackMin) consommé par le scanner
 * en place du cooldown fixe global.
 *
 * Default OFF (env-gated) — back-compat : sans le flag, returns fallback toujours.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import {
  computeAllSymbolCooldowns,
  parseAdaptiveCooldownConfig,
  type AdaptiveCooldownConfig,
  type SymbolCooldownVerdict,
  type SymbolTrade,
} from './adaptive-cooldown.helper';

@Injectable()
export class AdaptiveCooldownService {
  private readonly logger = new Logger(AdaptiveCooldownService.name);
  private enabled = false;
  private cfg: AdaptiveCooldownConfig = {
    baseCooldownMin: 60, highCooldownMin: 120, trapCooldownMin: 180,
    reentryWindowMin: 60, reentryLossRateMid: 0.50, reentryLossRateHigh: 0.70,
    minSls: 3, minReentries: 2,
  };
  private cache = new Map<string, SymbolCooldownVerdict>();
  private lastRefreshAt: Date | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  async onModuleInit(): Promise<void> {
    const parsed = parseAdaptiveCooldownConfig({
      ADAPTIVE_COOLDOWN_ENABLED: this.config.get<string>('ADAPTIVE_COOLDOWN_ENABLED'),
      ADAPTIVE_COOLDOWN_BASE_MIN: this.config.get<string>('ADAPTIVE_COOLDOWN_BASE_MIN'),
      ADAPTIVE_COOLDOWN_HIGH_MIN: this.config.get<string>('ADAPTIVE_COOLDOWN_HIGH_MIN'),
      ADAPTIVE_COOLDOWN_TRAP_MIN: this.config.get<string>('ADAPTIVE_COOLDOWN_TRAP_MIN'),
      ADAPTIVE_COOLDOWN_REENTRY_WINDOW_MIN: this.config.get<string>('ADAPTIVE_COOLDOWN_REENTRY_WINDOW_MIN'),
      ADAPTIVE_COOLDOWN_RELOSS_MID: this.config.get<string>('ADAPTIVE_COOLDOWN_RELOSS_MID'),
      ADAPTIVE_COOLDOWN_RELOSS_HIGH: this.config.get<string>('ADAPTIVE_COOLDOWN_RELOSS_HIGH'),
    });
    this.enabled = parsed.enabled;
    this.cfg = parsed.cfg;
    if (this.enabled) {
      this.logger.log(
        `[adaptive-cooldown] ENABLED — base=${this.cfg.baseCooldownMin}min high=${this.cfg.highCooldownMin}min trap=${this.cfg.trapCooldownMin}min`,
      );
      // Refresh au boot, best-effort
      await this.refresh().catch((e) =>
        this.logger.warn(`[adaptive-cooldown] boot refresh failed: ${String(e).slice(0, 150)}`),
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Cron hebdomadaire — refresh tous les dimanches 03:00 UTC.
   */
  @Cron('0 3 * * 0', { name: 'adaptive-cooldown-refresh', timeZone: 'UTC' })
  async cronRefresh(): Promise<void> {
    if (!this.enabled) return;
    await this.refresh().catch((e) =>
      this.logger.warn(`[adaptive-cooldown] cron refresh failed: ${String(e).slice(0, 200)}`),
    );
  }

  /**
   * Exposé pour le scanner POST-SL cooldown. Si désactivé ou symbole non
   * analysé → fallbackMin. Retourne directement le cooldown adaptatif issu
   * du pattern death-trap (60/120/180min selon re-loss rate).
   */
  getCooldownForSymbol(symbol: string, fallbackMin: number): number {
    if (!this.enabled) return fallbackMin;
    const v = this.cache.get(symbol);
    if (!v) return fallbackMin;
    return v.cooldownMin;
  }

  /**
   * P19-EXT (25/05) — Exposé pour le scanner STANDARD cooldown re-entry
   * (après TP, manual close, invalidated, expired — pas que SL).
   *
   * Stratégie : scale le fallback standard par le risk profile du symbol
   * (death-trap → ×3, mid-risk → ×2, safe → ×1) sans jamais descendre
   * sous le fallback. Plus conservateur que getCooldownForSymbol qui
   * remplace direct.
   *
   * Default OFF (env-gated comme le reste). Sans flag, returns fallback.
   *
   * Rationale : un symbole en "death-trap pattern" (re-loss rate > 70%)
   * mérite un cooldown étendu même après TP — la volatilité observée 30j
   * suggère que le pattern reste actif. Inversement, pour un symbole safe
   * (re-loss < 50% ou pas assez de data), keep fallback intact.
   */
  getStandardCooldownForSymbol(symbol: string, fallbackMin: number): number {
    if (!this.enabled) return fallbackMin;
    const v = this.cache.get(symbol);
    if (!v) return fallbackMin;
    if (v.cooldownMin >= this.cfg.trapCooldownMin) return fallbackMin * 3;
    if (v.cooldownMin >= this.cfg.highCooldownMin) return fallbackMin * 2;
    return fallbackMin;
  }

  /**
   * Exposé pour debug / endpoint admin futur.
   */
  getAllVerdicts(): SymbolCooldownVerdict[] {
    return Array.from(this.cache.values());
  }

  /**
   * Recompute depuis lisa_positions sur les 30 derniers jours.
   * Best-effort : si fetch fail, garde le cache précédent.
   */
  async refresh(): Promise<void> {
    if (!this.supabase.isReady()) return;
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const { data, error } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('symbol, entry_timestamp, exit_timestamp, status, realized_pnl_usd')
      .gte('entry_timestamp', since)
      .order('entry_timestamp', { ascending: true });
    if (error) {
      this.logger.warn(`[adaptive-cooldown] fetch lisa_positions: ${error.message}`);
      return;
    }
    const trades: SymbolTrade[] = ((data ?? []) as Array<{
      symbol: string; entry_timestamp: string; exit_timestamp: string | null; status: string; realized_pnl_usd: number | null;
    }>).map((r) => ({
      symbol: r.symbol,
      entry_at: r.entry_timestamp,
      exit_at: r.exit_timestamp,
      status: r.status,
      pnl_usd: r.realized_pnl_usd,
    }));

    const verdicts = computeAllSymbolCooldowns(trades, this.cfg);
    this.cache = verdicts;
    this.lastRefreshAt = new Date();

    // Log résumé (combien de symboles dans chaque catégorie)
    const counts = { base: 0, high: 0, trap: 0 };
    for (const v of verdicts.values()) {
      if (v.cooldownMin >= this.cfg.trapCooldownMin) counts.trap++;
      else if (v.cooldownMin >= this.cfg.highCooldownMin) counts.high++;
      else counts.base++;
    }
    this.logger.log(
      `[adaptive-cooldown] refresh OK — ${verdicts.size} symbols (${counts.base} safe / ${counts.high} mid / ${counts.trap} death-trap)`,
    );
  }
}
