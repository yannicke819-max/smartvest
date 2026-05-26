/**
 * P19v (30/04/2026 09:00 UTC) — EodhdQuotaService centralisé.
 *
 * Source de vérité pour le quota EODHD daily (100k API calls/jour, plan
 * ALL-IN-ONE). Consolide les responsabilités auparavant scattered :
 *   - cost map par endpoint type (intraday=5, fundamentals=10, bulk=100)
 *   - reconciliation 60s avec /api/user (truth source authoritative)
 *   - auto-throttle thresholds (70/85/95/99/100 %)
 *   - observability /admin/eodhd-status (per-endpoint breakdown, ETA exhaustion)
 *
 * Note refactor : ce PR fournit le SKELETON. Les call sites EODHD existants
 * (eod-provider, eodhd-intraday, eodhd-screener, top-gainers-scanner, etc.)
 * sont refactorés vers `executeWithBudget()` dans le PR follow-up #146.
 *
 * Pour l'instant ce PR :
 *   - expose `getStatus()` pour /admin/eodhd-status
 *   - expose `shouldPause(category)` qui combine env flags + auto-throttle state
 *   - publie les seuils auto-throttle (70/85/95/99/100 %)
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

/** Catégorie d'endpoint EODHD avec coût en API calls. */
export type EodhdEndpoint =
  | 'live'           // /api/real-time/{ticker}                    : 1 / symbol
  | 'eod'            // /api/eod/{ticker}                          : 1 / symbol
  | 'search'         // /api/search/{query}                        : 1
  | 'screener'       // /api/screener                              : 1
  | 'exchange_list'  // /api/exchange-symbol-list                  : 1
  | 'exchange_details' // /api/exchange-details/{exchange}         : 1
  | 'user'           // /api/user, /api/internal-user              : 0 (free)
  | 'intraday'       // /api/intraday/{ticker}                     : 5
  | 'technical'      // /api/technical/{ticker}                    : 5
  | 'news'           // /api/news                                  : 5 + 5×N tickers
  | 'sentiment'      // /api/sentiments                            : 5 + 5×N tickers
  | 'fundamentals'   // /api/fundamentals/{ticker}                 : 10
  | 'options'        // /api/options/{ticker}                      : 10
  | 'insider'        // /api/insider-transactions                  : 10
  | 'macro'          // /api/macro-indicator                       : 10
  | 'calendar'       // /api/calendar/earnings                     : 10
  | 'bulk'           // /api/eod-bulk-last-day                     : 100
  | 'marketplace';   // /api/mp/* (Marketplace products)           : 10

/** Coût en API calls par endpoint. Source : EODHD doc rate-limits.md. */
export const ENDPOINT_COST: Record<EodhdEndpoint, number> = {
  live: 1,
  eod: 1,
  search: 1,
  screener: 1,
  exchange_list: 1,
  exchange_details: 1,
  user: 0,
  intraday: 5,
  technical: 5,
  news: 5,
  sentiment: 5,
  fundamentals: 10,
  options: 10,
  insider: 10,
  macro: 10,
  calendar: 10,
  bulk: 100,
  marketplace: 10,
};

/** Categories pause-able via env flag ou auto-throttle. */
export type PauseCategory = 'scanner' | 'multitf' | 'all';

/** Seuils auto-throttle (% du daily cap). */
export const THROTTLE_THRESHOLDS = {
  warn: 0.70,        // 70% : log warn, scanner toujours actif
  scanner: 0.85,     // 85% : auto-pause scanner top-gainers + screener
  multitf: 0.95,     // 95% : auto-pause multi-tf-persistence (intraday 5x)
  essentials: 0.99,  // 99% : mode "live-only" (portfolio refresh seul, cache 5min)
  hard: 1.00,        // 100% : hard block, wait reset 00:00 UTC
} as const;

export interface QuotaStatus {
  // Authoritative depuis /api/user (truth source)
  authoritative: {
    apiRequests: number;
    dailyRateLimit: number;
    extraLimit: number;
    asOf: string | null;
  };
  // Local projected (par-endpoint counter, peut différer de l'auth)
  local: {
    totalProjected: number;
    perEndpoint: Record<string, number>;
    burnRatePerMin: number; // sliding window 60s
  };
  // Auto-throttle state
  throttle: {
    scannerPaused: boolean;     // env SCANNER_PAUSE OR auto >= 85%
    multitfPaused: boolean;     // env MULTITF_PAUSE OR auto >= 95%
    essentialsOnly: boolean;    // auto >= 99%
    hardBlocked: boolean;       // auto >= 100%
    pauseReason: string | null; // 'env_scanner' | 'auto_85pct' | etc.
  };
  // ETA exhaustion (minutes restants au rythme actuel)
  etaExhaustionMinutes: number | null;
}

@Injectable()
export class EodhdQuotaService {
  private readonly logger = new Logger(EodhdQuotaService.name);

  /** Compteur par-endpoint local (réinitialisé à chaque reconcile auth). */
  private perEndpointCount: Map<EodhdEndpoint, number> = new Map();
  /** Sliding window des coûts récents (timestamp + cost) pour burn rate /min. */
  private recentCosts: Array<{ ts: number; cost: number }> = [];

  /** Snapshot authoritative depuis /api/user (refresh 60s). */
  private auth = {
    apiRequests: 0,
    dailyRateLimit: 100_000,
    extraLimit: 0,
    asOf: 0,
  };

  constructor(private readonly config: ConfigService) {}

  /**
   * PR #260 — Cron 30s pour reconcile authoritative depuis /api/user.
   * Sans ce cron, `refreshAuth()` n'est jamais appelée automatiquement et
   * `auth.apiRequests` reste à 0 perpétuellement → UI quota indicator stuck
   * à "0 / 100k" même quand on consomme 100k+ calls/jour.
   *
   * Le call /api/user lui-même est gratuit (0 calls comptés). Refresh 30s
   * suffit pour la latence d'auto-throttle (85% threshold).
   *
   * `refreshAuth()` a son propre throttle interne (60s) — on appelle 30s
   * pour double-buffering en cas de tick raté.
   */
  @Cron('*/30 * * * * *', { timeZone: 'UTC' })
  async reconcileAuthCron(): Promise<void> {
    await this.refreshAuth();
  }

  /** Coût en API calls pour un endpoint donné (avec multi-ticker support). */
  static costOf(endpoint: EodhdEndpoint, tickerCount = 1): number {
    const base = ENDPOINT_COST[endpoint];
    // News/sentiment : 5 + 5×N. Live/EOD : 1 par ticker.
    if (endpoint === 'news' || endpoint === 'sentiment') {
      return base + base * tickerCount;
    }
    if (endpoint === 'live' || endpoint === 'eod') {
      return base * tickerCount;
    }
    return base;
  }

  /**
   * Wrapper budget-aware autour d'un appel EODHD.
   * Vérifie budget, exécute, incrémente counter local. Si 402 → force counter = limit.
   *
   * Note : refactor des call sites existants à faire dans PR #146.
   */
  async executeWithBudget<T>(
    endpoint: EodhdEndpoint,
    fn: () => Promise<T>,
    tickerCount = 1,
  ): Promise<T> {
    // Hard block check
    const status = this.getStatus();
    if (status.throttle.hardBlocked) {
      throw new Error(
        `[eodhd-quota] hard block (${status.authoritative.apiRequests}/${status.authoritative.dailyRateLimit}, wait reset 00:00 UTC)`,
      );
    }
    const cost = EodhdQuotaService.costOf(endpoint, tickerCount);
    try {
      const result = await fn();
      this.recordCall(endpoint, cost);
      return result;
    } catch (err) {
      // Si 402 → force counter à limite (authoritative cap signal)
      const errMsg = (err as Error)?.message ?? '';
      if (errMsg.includes('402') || errMsg.includes('Payment Required')) {
        this.logger.warn(`[eodhd-quota] 402 received on ${endpoint} — forcing local counter to limit`);
        this.auth.apiRequests = this.auth.dailyRateLimit;
      }
      throw err;
    }
  }

  /** Record un call (cost déjà computed) — appelé manuellement par les sites
   *  non-encore refactorés vers executeWithBudget. */
  recordCall(endpoint: EodhdEndpoint, cost: number): void {
    this.perEndpointCount.set(endpoint, (this.perEndpointCount.get(endpoint) ?? 0) + cost);
    this.recentCosts.push({ ts: Date.now(), cost });
    // Trim sliding window à 60s
    const cutoff = Date.now() - 60_000;
    this.recentCosts = this.recentCosts.filter((r) => r.ts > cutoff);
  }

  /** Récupère le snapshot /api/user authoritative. Cache 60s. */
  async refreshAuth(): Promise<void> {
    const now = Date.now();
    if (now - this.auth.asOf < 60_000) return;
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey || apiKey === 'demo') return;

    try {
      const url = `https://eodhd.com/api/user?api_token=${apiKey}&fmt=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        this.logger.debug(`[eodhd-quota] /api/user HTTP ${res.status}`);
        return;
      }
      const data = await res.json() as Record<string, unknown>;
      // PR #469 — log brut au premier refresh pour valider que /api/user
      // renvoie bien `extraLimit` (et pas un autre nom — EODHD peut changer
      // le format silencieusement). Permet de fix le parser si besoin.
      if (this.auth.asOf === 0) {
        this.logger.log(`[eodhd-quota] /api/user raw keys: ${Object.keys(data).join(',')} — sample: ${JSON.stringify(data).slice(0, 400)}`);
      }
      if (typeof data.apiRequests === 'number') this.auth.apiRequests = data.apiRequests;
      if (typeof data.dailyRateLimit === 'number' && data.dailyRateLimit > 0) {
        this.auth.dailyRateLimit = data.dailyRateLimit;
      }
      if (typeof data.extraLimit === 'number') this.auth.extraLimit = data.extraLimit;
      // PR #469 — fallback sur d'autres noms possibles (EODHD docs vs reality drift)
      if (this.auth.extraLimit === 0) {
        const fallbackExtra = data.extra_limit ?? data.extraApiRequests ?? data.extra_api_requests ?? data.additionalRemaining ?? data.additional_remaining;
        if (typeof fallbackExtra === 'number' && fallbackExtra > 0) {
          this.auth.extraLimit = fallbackExtra;
        }
      }
      this.auth.asOf = now;
    } catch (e) {
      this.logger.debug(`[eodhd-quota] refreshAuth failed: ${String(e).slice(0, 80)}`);
    }
  }

  /** Indique si une catégorie de calls doit être paused.
   *  Combine env flag (manual override) ET auto-throttle (% authoritative). */
  shouldPause(category: PauseCategory): { paused: boolean; reason: string | null } {
    // Env manual override (highest priority)
    if (category === 'scanner' || category === 'all') {
      const envScanner = (this.config.get<string>('SCANNER_PAUSE') ?? 'false').toLowerCase() === 'true';
      if (envScanner) return { paused: true, reason: 'env_SCANNER_PAUSE' };
    }
    if (category === 'multitf' || category === 'all') {
      const envMultitf = (this.config.get<string>('MULTITF_PAUSE') ?? 'false').toLowerCase() === 'true';
      if (envMultitf) return { paused: true, reason: 'env_MULTITF_PAUSE' };
    }

    // Auto-throttle based on authoritative usage %
    // PR #469 — kill-switch env `EODHD_AUTO_THROTTLE_DISABLED=true` pour
    // bypass complet (utile si /api/user ne renvoie pas extraLimit correctement
    // ou si on veut consommer la réserve extra credits sans hésiter).
    const autoThrottleDisabled = (this.config.get<string>('EODHD_AUTO_THROTTLE_DISABLED') ?? 'false').toLowerCase() === 'true';
    if (autoThrottleDisabled) return { paused: false, reason: null };

    const totalCap = this.auth.dailyRateLimit + this.auth.extraLimit;
    if (totalCap === 0) return { paused: false, reason: null };
    const usagePct = this.auth.apiRequests / totalCap;

    if (usagePct >= THROTTLE_THRESHOLDS.hard) {
      return { paused: true, reason: 'auto_100pct_hard_block' };
    }
    if (category === 'scanner' && usagePct >= THROTTLE_THRESHOLDS.scanner) {
      return { paused: true, reason: 'auto_85pct_scanner' };
    }
    if (category === 'multitf' && usagePct >= THROTTLE_THRESHOLDS.multitf) {
      return { paused: true, reason: 'auto_95pct_multitf' };
    }
    return { paused: false, reason: null };
  }

  /** Status complet pour /admin/eodhd-status endpoint. */
  getStatus(): QuotaStatus {
    const now = Date.now();
    const cutoff = now - 60_000;
    this.recentCosts = this.recentCosts.filter((r) => r.ts > cutoff);
    const burnRatePerMin = this.recentCosts.reduce((s, r) => s + r.cost, 0);

    const totalProjected = Array.from(this.perEndpointCount.values()).reduce((s, v) => s + v, 0);
    const perEndpoint: Record<string, number> = {};
    for (const [k, v] of this.perEndpointCount) perEndpoint[k] = v;

    const totalCap = this.auth.dailyRateLimit + this.auth.extraLimit;
    const remaining = Math.max(0, totalCap - this.auth.apiRequests);
    const etaExhaustionMinutes = burnRatePerMin > 0 ? Math.floor(remaining / burnRatePerMin) : null;

    const scannerStatus = this.shouldPause('scanner');
    const multitfStatus = this.shouldPause('multitf');
    const usagePct = totalCap > 0 ? this.auth.apiRequests / totalCap : 0;

    return {
      authoritative: {
        apiRequests: this.auth.apiRequests,
        dailyRateLimit: this.auth.dailyRateLimit,
        extraLimit: this.auth.extraLimit,
        asOf: this.auth.asOf > 0 ? new Date(this.auth.asOf).toISOString() : null,
      },
      local: {
        totalProjected,
        perEndpoint,
        burnRatePerMin,
      },
      throttle: {
        scannerPaused: scannerStatus.paused,
        multitfPaused: multitfStatus.paused,
        essentialsOnly: usagePct >= THROTTLE_THRESHOLDS.essentials,
        hardBlocked: usagePct >= THROTTLE_THRESHOLDS.hard,
        pauseReason: scannerStatus.reason ?? multitfStatus.reason ?? null,
      },
      etaExhaustionMinutes,
    };
  }
}
