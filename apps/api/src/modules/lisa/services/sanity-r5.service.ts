import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * R5 sanity exit_price — hotfix smoking gun SEE.LSE (14 mai).
 *
 * Position c01e6f74-… a été fermée avec exit_price=0.0000, pnl_pct=-99.948%.
 * Cause : aucun garde-fou ne rejetait un exit_price aberrant à l'écriture
 * Supabase. R5 sanity arrête net les 3 cas pathologiques :
 *
 *   1. exit_price <= 0
 *   2. exit_price < entry_price × R5_EXIT_PRICE_MIN_RATIO  (default 0.5)
 *   3. realized_pnl_pct < R5_PNL_PCT_MIN_THRESHOLD         (default -50)
 *
 * Sur rejet : la position N'EST PAS fermée (reste open), audit dans
 * lisa_sanity_rejections, log err. Le caller doit interpréter `ok=false`
 * comme un signal de ne pas écrire la fermeture.
 */

export type SanityR5Raison =
  | 'exit_price_zero'
  | 'exit_below_ratio'
  | 'pnl_pct_below_threshold';

export interface SanityR5Input {
  entryPrice: number;
  exitPrice: number;
  realizedPnlPct: number;
  positionId: string;
  symbol: string;
  assetClass: string;
}

export interface SanityR5Output {
  ok: boolean;
  raison?: SanityR5Raison;
  detail?: string;
}

@Injectable()
export class SanityR5Service {
  private readonly logger = new Logger(SanityR5Service.name);
  private readonly enabled: boolean;
  private readonly minRatio: number;
  private readonly minPnlPct: number;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    this.enabled = (this.config.get<string>('R5_SANITY_ENABLED') ?? 'true') === 'true';
    const rRaw = this.config.get<string>('R5_EXIT_PRICE_MIN_RATIO');
    const pRaw = this.config.get<string>('R5_PNL_PCT_MIN_THRESHOLD');
    const r = rRaw != null ? Number.parseFloat(rRaw) : NaN;
    const p = pRaw != null ? Number.parseFloat(pRaw) : NaN;
    this.minRatio = Number.isFinite(r) ? r : 0.5;
    this.minPnlPct = Number.isFinite(p) ? p : -50;
  }

  /**
   * Valide les paramètres de fermeture. Si invalide, écrit un audit dans
   * lisa_sanity_rejections (best-effort, ne fait jamais throw).
   */
  async validateExit(input: SanityR5Input): Promise<SanityR5Output> {
    if (!this.enabled) {
      return { ok: true };
    }

    let raison: SanityR5Raison | null = null;
    let detail = '';

    if (!Number.isFinite(input.exitPrice) || input.exitPrice <= 0) {
      raison = 'exit_price_zero';
      detail = `exit_price=${input.exitPrice}`;
    } else if (
      Number.isFinite(input.entryPrice) &&
      input.entryPrice > 0 &&
      input.exitPrice < input.entryPrice * this.minRatio
    ) {
      raison = 'exit_below_ratio';
      detail = `exit=${input.exitPrice} entry=${input.entryPrice} ratio=${(input.exitPrice / input.entryPrice).toFixed(4)} min=${this.minRatio}`;
    } else if (
      Number.isFinite(input.realizedPnlPct) &&
      input.realizedPnlPct < this.minPnlPct
    ) {
      raison = 'pnl_pct_below_threshold';
      detail = `pnl_pct=${input.realizedPnlPct} threshold=${this.minPnlPct}`;
    }

    if (raison === null) {
      return { ok: true };
    }

    this.logger.error(
      `[R5_SANITY_REJECT] ${input.symbol} (${input.assetClass}) position=${input.positionId} raison=${raison} ${detail}`,
    );

    await this.persistRejection(input, raison);

    return { ok: false, raison, detail };
  }

  private async persistRejection(input: SanityR5Input, raison: SanityR5Raison): Promise<void> {
    if (!this.supabase.isReady()) return;
    try {
      const { error } = await this.supabase
        .getClient()
        .from('lisa_sanity_rejections')
        .insert({
          position_id: input.positionId,
          symbol: input.symbol,
          asset_class: input.assetClass,
          raw_exit_price: input.exitPrice,
          raw_pnl_pct: input.realizedPnlPct,
          raison,
          entry_price: input.entryPrice,
        });
      if (error) {
        this.logger.warn(`sanity-r5 audit insert failed: ${error.message}`);
      }
    } catch (err) {
      this.logger.warn(`sanity-r5 audit exception: ${(err as Error).message}`);
    }
  }
}
