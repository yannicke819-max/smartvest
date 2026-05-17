import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * PR #344 P1 — service partagé de log des appels EODHD.
 *
 * Extrait de `LisaService.logEodhdCall` (private) pour permettre l'instrumentation
 * 100 % des appels EODHD (gap 78 % du quota actuellement invisible).
 *
 * Fire-and-forget : aucune erreur d'insert ne remonte au caller (warn log seulement).
 *
 * Champs étendus PR #344 vs version legacy :
 *   - endpoint : URL relative EODHD ('screener', 'eod', 'real-time', etc.) — sépare
 *     l'attribution par endpoint vs called_by (qui identifie le consumer).
 *   - extras : JSONB libre pour métadonnées (n_symbols_returned, credits_estimes,
 *     cache_hit, page/offset, ...).
 *
 * Le contrat reste compatible avec `LisaService.logEodhdCall` legacy : tous les
 * champs hors `ticker`/`success`/`calledBy` sont optionnels. Les call sites existants
 * peuvent être migrés progressivement sans refacto big-bang.
 */

export interface EodhdLogEntry {
  ticker: string;
  eodhdTicker?: string | null;
  source?: 'eodhd' | 'fallback' | 'supabase_quotes' | 'yahoo' | 'stooq' | 'fred';
  success: boolean;
  statusCode?: number | null | undefined;
  latencyMs?: number | undefined;
  priceUsd?: number | null | undefined;
  /** Identifiant du consumer ('live_price', 'market_snapshot', 'screener', etc.). */
  calledBy: string;
  /** PR #344 — endpoint EODHD relatif ('screener', 'eod', 'real-time', ...). */
  endpoint?: string | undefined;
  /** PR #344 — métadonnées libres (n_symbols_returned, credits_estimes, ...). */
  extras?: Record<string, unknown> | undefined;
  errorMessage?: string | undefined;
}

@Injectable()
export class EodhdLoggerService {
  private readonly logger = new Logger(EodhdLoggerService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Insert append-only dans `eodhd_request_log`. Fire-and-forget : ne throw jamais,
   * warn local si Supabase rejette.
   */
  log(entry: EodhdLogEntry): void {
    if (!this.supabase.isReady()) return;
    void (async () => {
      try {
        const { error } = await this.supabase
          .getClient()
          .from('eodhd_request_log')
          .insert({
            ticker: entry.ticker,
            eodhd_ticker: entry.eodhdTicker ?? null,
            source: entry.source ?? 'eodhd',
            success: entry.success,
            status_code: entry.statusCode ?? null,
            latency_ms: entry.latencyMs ?? null,
            price_usd: entry.priceUsd ?? null,
            called_by: entry.calledBy,
            endpoint: entry.endpoint ?? null,
            extras: entry.extras ?? null,
            error_message: entry.errorMessage ?? null,
          });
        if (error) {
          this.logger.warn(`eodhd_request_log insert failed: ${error.message}`);
        }
      } catch (err) {
        this.logger.warn(`eodhd_request_log insert exception: ${(err as Error).message}`);
      }
    })();
  }

  /**
   * Helper pour estimer les crédits EODHD consommés par appel, selon les barèmes
   * documentés. Utilisé pour peupler `extras.credits_estimes` sur l'audit post-deploy.
   *
   * Référence : vendor/eodhd-claude-skills/skills/eodhd-api/references/general/pricing-and-plans.md
   */
  static estimateCredits(endpoint: string, extras?: Record<string, unknown>): number {
    switch (endpoint) {
      case 'screener': {
        const n = Number(extras?.n_symbols_returned ?? 0);
        return 5 + (Number.isFinite(n) ? n : 0);
      }
      case 'intraday':
        return 5;
      case 'technical':
        return 5;
      case 'insider':
      case 'options':
        return 10;
      case 'real-time':
      case 'eod':
      case 'exchange-hours':
        return 1;
      default:
        return 1;
    }
  }
}
