import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

export interface SanityRow {
  id: string;
  symbol: string;
  asset_class: string | null;
  raw_exit_price: number | null;
  raw_pnl_pct: number | null;
  raison: string;
  rejected_at: string;
}

export interface RiskStateResponse {
  circuit_breaker: {
    is_tripped: boolean;
    triggered_at: string | null;
    reason: string | null;
    pnl_at_trigger: number | null;
    positions_open_at_trigger: number | null;
    resolved_at: string | null;
    notes: string | null;
  };
  sanity_rejections: {
    count_24h: number;
    recent: SanityRow[];
  };
  feature_flags: {
    quick_wins_pipeline_enabled: boolean;
    gainers_nse_blacklist_enabled: boolean;
  };
}

/**
 * PR #338 — aggrégation état de risque d'un portfolio pour le bandeau UI :
 *   - circuit breaker actif si dernière ligne `lisa_circuit_breaker_state`
 *     a `resolved_at IS NULL`
 *   - sanity rejections (count 24h + 20 dernières) depuis `lisa_sanity_rejections`
 *   - lecture read-only des flags feature côté ConfigService
 *
 * Toutes les requêtes Supabase sont concurrentes via `Promise.all`.
 */
@Injectable()
export class RiskStateService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  async portfolioRiskState(portfolioId: string): Promise<RiskStateResponse> {
    if (!portfolioId) {
      throw new BadRequestException('portfolioId requis');
    }

    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [cbResult, recentResult, count24hResult] = await Promise.all([
      this.supabase
        .getClient()
        .from('lisa_circuit_breaker_state')
        .select('id, triggered_at, reason, pnl_at_trigger, positions_open_at_trigger, resolved_at, notes')
        .eq('portfolio_id', portfolioId)
        .order('triggered_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      this.supabase
        .getClient()
        .from('lisa_sanity_rejections')
        .select('id, symbol, asset_class, raw_exit_price, raw_pnl_pct, raison, rejected_at')
        .order('rejected_at', { ascending: false })
        .limit(20),
      this.supabase
        .getClient()
        .from('lisa_sanity_rejections')
        .select('id', { count: 'exact', head: true })
        .gte('rejected_at', sinceIso),
    ]);

    if (cbResult.error) throw new BadRequestException(cbResult.error.message);
    if (recentResult.error) throw new BadRequestException(recentResult.error.message);
    if (count24hResult.error) throw new BadRequestException(count24hResult.error.message);

    const cbRow = cbResult.data as {
      id: string;
      triggered_at: string | null;
      reason: string | null;
      pnl_at_trigger: number | null;
      positions_open_at_trigger: number | null;
      resolved_at: string | null;
      notes: string | null;
    } | null;
    const isTripped = Boolean(cbRow && !cbRow.resolved_at);

    return {
      circuit_breaker: {
        is_tripped: isTripped,
        triggered_at: cbRow?.triggered_at ?? null,
        reason: cbRow?.reason ?? null,
        pnl_at_trigger: cbRow?.pnl_at_trigger ?? null,
        positions_open_at_trigger: cbRow?.positions_open_at_trigger ?? null,
        resolved_at: cbRow?.resolved_at ?? null,
        notes: cbRow?.notes ?? null,
      },
      sanity_rejections: {
        count_24h: count24hResult.count ?? 0,
        recent: (recentResult.data ?? []) as SanityRow[],
      },
      feature_flags: {
        quick_wins_pipeline_enabled: (this.config.get<string>('QUICK_WINS_PIPELINE_ENABLED') ?? 'false') === 'true',
        gainers_nse_blacklist_enabled: (this.config.get<string>('GAINERS_NSE_BLACKLIST_ENABLED') ?? 'true') !== 'false',
      },
    };
  }
}
