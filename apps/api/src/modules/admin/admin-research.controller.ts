/**
 * Admin Research endpoints — exploitation du dataset propriétaire SmartVest.
 *
 * top_gainers_log = 259k rows (chaque minute, top 10 gainers globaux avec
 * 5 sub-scores). C'est une donnée que personne d'autre n'a. Cet endpoint
 * compute la prédictivité de chaque sub-score sur l'outcome réel
 * (joined avec lisa_positions.realized_pnl_pct).
 *
 * Pas de ML lib (XGBoost) en V1 — juste stats descriptives par band.
 * Si un sub-score montre WR > 60% sur un band donné, c'est un signal
 * exploitable comme gate. La V2 (futur PR) introduira un fit logistic
 * regression cross-validé.
 *
 * Endpoints :
 *   GET /admin/research/gainers-feature-power  → conditional WR par feature
 *   GET /admin/research/cross-region-lag       → corrélation US AH → Asia open
 *
 * Auth : x-admin-token (constant-time compare).
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';

interface JoinedTrade {
  symbol: string;
  continuous_score_total: number | null;
  sub_persistence_score: number | null;
  sub_momentum_score: number | null;
  sub_rvol_score: number | null;
  sub_amplitude_score: number | null;
  sub_cap_quality_score: number | null;
  realized_pnl_pct: number | null;
  realized_pnl_usd: number | null;
  asset_class: string | null;
  entry_hour_utc: number | null;
}

@Controller('admin/research')
export class AdminResearchController {
  private readonly logger = new Logger(AdminResearchController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get('gainers-feature-power')
  async gainersFeaturePower(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('limit') limitRaw?: string,
  ): Promise<{
    n_total: number;
    by_continuous_score_band: ReturnType<typeof AdminResearchController.statsByBand>;
    by_persistence_band: ReturnType<typeof AdminResearchController.statsByBand>;
    by_momentum_band: ReturnType<typeof AdminResearchController.statsByBand>;
    by_rvol_band: ReturnType<typeof AdminResearchController.statsByBand>;
    by_amplitude_band: ReturnType<typeof AdminResearchController.statsByBand>;
    by_asset_class: ReturnType<typeof AdminResearchController.statsByBand>;
    by_hour_utc: ReturnType<typeof AdminResearchController.statsByBand>;
    best_combo_suggestion: { band: string; n: number; wr_pct: number; mean_pnl_pct: number } | null;
  }> {
    this.assertAdmin(providedToken);
    if (!this.supabase.isReady()) {
      throw new HttpException({ message: 'Supabase not ready' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const limit = Math.max(100, Math.min(5000, Number.parseInt(limitRaw ?? '2000', 10) || 2000));

    // Join in-memory (PostgREST n'a pas de JOIN cross-table sans foreign key)
    const { data: opens } = await this.supabase
      .getClient()
      .from('top_gainers_log')
      .select('symbol, continuous_score_total, sub_persistence_score, sub_momentum_score, sub_rvol_score, sub_amplitude_score, sub_cap_quality_score, detected_asset_class, opened_position_id')
      .eq('decision', 'opened')
      .not('opened_position_id', 'is', null)
      .order('captured_at', { ascending: false })
      .limit(limit);

    const rows = (opens ?? []) as Array<{ symbol: string; continuous_score_total: number | null; sub_persistence_score: number | null; sub_momentum_score: number | null; sub_rvol_score: number | null; sub_amplitude_score: number | null; sub_cap_quality_score: number | null; detected_asset_class: string | null; opened_position_id: string | null }>;
    if (rows.length === 0) {
      return AdminResearchController.emptyResponse();
    }

    const ids = rows.map((r) => r.opened_position_id).filter((x): x is string => !!x);
    if (ids.length === 0) return AdminResearchController.emptyResponse();
    const { data: closed } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('id, realized_pnl_pct, realized_pnl_usd, entry_timestamp')
      .in('id', ids)
      .neq('status', 'open');
    const closedMap = new Map<string, { pnl_pct: number | null; pnl_usd: number | null; entry_ts: string }>();
    for (const c of (closed ?? []) as Array<{ id: string; realized_pnl_pct: number | null; realized_pnl_usd: number | null; entry_timestamp: string }>) {
      closedMap.set(c.id, { pnl_pct: c.realized_pnl_pct, pnl_usd: c.realized_pnl_usd, entry_ts: c.entry_timestamp });
    }

    const joined: JoinedTrade[] = [];
    for (const r of rows) {
      if (!r.opened_position_id) continue;
      const c = closedMap.get(r.opened_position_id);
      if (!c) continue;
      const hr = c.entry_ts ? Number.parseInt(c.entry_ts.slice(11, 13), 10) : null;
      joined.push({
        symbol: r.symbol,
        continuous_score_total: r.continuous_score_total,
        sub_persistence_score: r.sub_persistence_score,
        sub_momentum_score: r.sub_momentum_score,
        sub_rvol_score: r.sub_rvol_score,
        sub_amplitude_score: r.sub_amplitude_score,
        sub_cap_quality_score: r.sub_cap_quality_score,
        realized_pnl_pct: c.pnl_pct,
        realized_pnl_usd: c.pnl_usd,
        asset_class: r.detected_asset_class,
        entry_hour_utc: Number.isFinite(hr) ? hr : null,
      });
    }

    const bands_score = AdminResearchController.statsByBand(joined, (t) => AdminResearchController.scoreBand(t.continuous_score_total));
    const bands_pers = AdminResearchController.statsByBand(joined, (t) => AdminResearchController.subBand(t.sub_persistence_score));
    const bands_mom = AdminResearchController.statsByBand(joined, (t) => AdminResearchController.subBand(t.sub_momentum_score));
    const bands_rvol = AdminResearchController.statsByBand(joined, (t) => AdminResearchController.subBand(t.sub_rvol_score));
    const bands_ampl = AdminResearchController.statsByBand(joined, (t) => AdminResearchController.subBand(t.sub_amplitude_score));
    const bands_class = AdminResearchController.statsByBand(joined, (t) => t.asset_class ?? 'null');
    const bands_hour = AdminResearchController.statsByBand(joined, (t) => t.entry_hour_utc != null ? `H${String(t.entry_hour_utc).padStart(2, '0')}` : 'null');

    // Best combo : si on prend continuous_score ≥ 50 ET asset_class us_equity_large
    const subset = joined.filter((t) => (t.continuous_score_total ?? 0) >= 50 && t.asset_class === 'us_equity_large');
    const bestCombo = subset.length >= 10 ? {
      band: 'continuous_score≥50 AND asset_class=us_equity_large',
      n: subset.length,
      wr_pct: Math.round((subset.filter((t) => (t.realized_pnl_usd ?? 0) > 0).length * 100) / subset.length),
      mean_pnl_pct: Math.round(subset.reduce((s, t) => s + (t.realized_pnl_pct ?? 0), 0) / subset.length * 1000) / 1000,
    } : null;

    return {
      n_total: joined.length,
      by_continuous_score_band: bands_score,
      by_persistence_band: bands_pers,
      by_momentum_band: bands_mom,
      by_rvol_band: bands_rvol,
      by_amplitude_band: bands_ampl,
      by_asset_class: bands_class,
      by_hour_utc: bands_hour,
      best_combo_suggestion: bestCombo,
    };
  }

  static statsByBand(joined: JoinedTrade[], keyFn: (t: JoinedTrade) => string): Array<{ band: string; n: number; wr_pct: number; mean_pnl_pct: number; sum_usd: number }> {
    const groups = new Map<string, JoinedTrade[]>();
    for (const t of joined) {
      const k = keyFn(t);
      const arr = groups.get(k) ?? [];
      arr.push(t);
      groups.set(k, arr);
    }
    return Array.from(groups.entries())
      .map(([band, arr]) => {
        const winners = arr.filter((t) => (t.realized_pnl_usd ?? 0) > 0).length;
        const sumPnlPct = arr.reduce((s, t) => s + (t.realized_pnl_pct ?? 0), 0);
        const sumUsd = arr.reduce((s, t) => s + (t.realized_pnl_usd ?? 0), 0);
        return {
          band,
          n: arr.length,
          wr_pct: Math.round((winners * 100) / arr.length),
          mean_pnl_pct: Math.round((sumPnlPct / arr.length) * 1000) / 1000,
          sum_usd: Math.round(sumUsd * 100) / 100,
        };
      })
      .sort((a, b) => b.n - a.n);
  }

  static scoreBand(score: number | null): string {
    if (score == null) return 'null';
    if (score < 40) return '1_lt_40';
    if (score < 50) return '2_40_50';
    if (score < 60) return '3_50_60';
    if (score < 70) return '4_60_70';
    if (score < 80) return '5_70_80';
    return '6_80+';
  }

  static subBand(sub: number | null): string {
    if (sub == null) return 'null';
    if (sub < 0.3) return '1_low_lt_0.3';
    if (sub < 0.6) return '2_mid_0.3-0.6';
    return '3_high_gte_0.6';
  }

  static emptyResponse() {
    return {
      n_total: 0,
      by_continuous_score_band: [],
      by_persistence_band: [],
      by_momentum_band: [],
      by_rvol_band: [],
      by_amplitude_band: [],
      by_asset_class: [],
      by_hour_utc: [],
      best_combo_suggestion: null,
    };
  }

  @Get('cross-region-lag')
  async crossRegionLag(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('days') daysRaw?: string,
  ): Promise<{
    days: number;
    sample_n: number;
    correlation_us_ah_to_asia_open: number | null;
    correlation_asia_eod_to_eu_open: number | null;
    note: string;
  }> {
    this.assertAdmin(providedToken);
    if (!this.supabase.isReady()) {
      throw new HttpException({ message: 'Supabase not ready' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const days = Math.max(7, Math.min(180, Number.parseInt(daysRaw ?? '30', 10) || 30));

    // V1 : juste un placeholder qui renvoie n=0 (ohlcv_cache_daily n'a pas
    // les sessions intraday nécessaires). V2 nécessitera de pull les opens
    // session-by-session via EODHD intraday + cache dans une nouvelle table.
    return {
      days,
      sample_n: 0,
      correlation_us_ah_to_asia_open: null,
      correlation_asia_eod_to_eu_open: null,
      note: 'V1 stub — V2 nécessite cron daily qui capture session opens (us_close, asia_open, eu_open) dans nouvelle table cross_region_sessions',
    };
  }

  private assertAdmin(providedToken: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || expected.length === 0) {
      throw new HttpException({ message: 'Endpoint disabled (ADMIN_TOKEN not configured)' }, HttpStatus.FORBIDDEN);
    }
    if (!providedToken) {
      throw new HttpException({ message: 'x-admin-token header required' }, HttpStatus.UNAUTHORIZED);
    }
    const a = Buffer.from(expected);
    const b = Buffer.from(providedToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpException({ message: 'Invalid admin token' }, HttpStatus.FORBIDDEN);
    }
  }
}
