import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * PR #268 — TradingStatsService : analytics + scaling readiness.
 *
 * Calcule 5 critères pour décider si l'edge est sustainable et si on peut
 * scaler le capital (paper → LIVE micro caps puis caps normaux). Retourne
 * un verdict consolidé READY / CAUTION / NOT_READY.
 *
 * Critères (cf. PRD IBKR LIVE Trading + retour user May 6/7) :
 *   1. profitable_ratio  ≥ 80%   (jours profitables / jours totaux)
 *   2. avg_daily_pnl     ≥ $50
 *   3. pnl_volatility    ≤ 1.0   (stddev / mean — coefficient of variation)
 *   4. worst_day         ≥ -$50
 *   5. win_rate_7day     ≥ 65%   (rolling 7 derniers jours)
 *
 * Verdict :
 *   - READY      : 5/5 critères passent
 *   - CAUTION    : 3-4/5 passent
 *   - NOT_READY  : 0-2/5 passent
 *
 * Cache 60s pour éviter de re-querier à chaque poll UI.
 */

type CriterionStatus = 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA';

export interface ScalingCriterion {
  name: string;
  label: string;
  value: number | null;
  target: number;
  unit: string;
  status: CriterionStatus;
  advice: string;
}

export interface TradingStatsResponse {
  period_days: number;
  metrics: {
    total_pnl: number;
    avg_daily_pnl: number;
    win_rate_pct: number;
    win_rate_7day_rolling: number;
    trades_count_total: number;
    trades_tp_sl_only: number;
    profitable_days: number;
    losing_days: number;
    flat_days: number;
    total_days: number;
    pnl_stddev: number;
    pnl_volatility_ratio: number;
    best_day: number;
    worst_day: number;
    expectancy_per_trade: number;
    avg_win_usd: number;
    avg_loss_usd: number;
  };
  scaling_criteria: ScalingCriterion[];
  verdict: 'READY' | 'CAUTION' | 'NOT_READY' | 'INSUFFICIENT_DATA';
  by_asset_class: Array<{
    asset_class: string;
    wins: number;
    losses: number;
    win_rate_pct: number | null;
    pnl_usd: number;
    trades_count: number;
  }>;
  daily_series: Array<{
    date: string;
    pnl_usd: number;
    wins: number;
    losses: number;
  }>;
  as_of: string;
}

@Injectable()
export class TradingStatsService {
  private readonly logger = new Logger(TradingStatsService.name);
  private readonly cache = new Map<string, { response: TradingStatsResponse; asOf: number }>();
  private readonly CACHE_MS = 60 * 1000;

  constructor(private readonly supabase: SupabaseService) {}

  async getStats(portfolioId: string, days = 30): Promise<TradingStatsResponse> {
    const safeDays = Math.max(1, Math.min(365, Math.floor(days)));
    const cacheKey = `${portfolioId}:${safeDays}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) {
      return cached.response;
    }

    const sinceIso = new Date(Date.now() - safeDays * 86_400_000).toISOString();

    const { data: positions, error } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('asset_class, status, exit_timestamp, realized_pnl_usd')
      .eq('portfolio_id', portfolioId)
      .neq('status', 'open')
      .gte('exit_timestamp', sinceIso);

    if (error) {
      this.logger.warn(`[trading-stats] query failed: ${error.message}`);
      return this.emptyResponse(safeDays);
    }

    const rows = (positions ?? []) as Array<{
      asset_class: string | null;
      status: string;
      exit_timestamp: string;
      realized_pnl_usd: string | number | null;
    }>;

    const response = this.computeStats(rows, safeDays);
    this.cache.set(cacheKey, { response, asOf: Date.now() });
    return response;
  }

  private computeStats(rows: Array<{
    asset_class: string | null;
    status: string;
    exit_timestamp: string;
    realized_pnl_usd: string | number | null;
  }>, days: number): TradingStatsResponse {
    const TP_STATUS = 'closed_target';
    const SL_STATUS = 'closed_stop';

    const pnlOf = (r: { realized_pnl_usd: string | number | null }): number => {
      if (r.realized_pnl_usd == null) return 0;
      const n = typeof r.realized_pnl_usd === 'string'
        ? parseFloat(r.realized_pnl_usd)
        : Number(r.realized_pnl_usd);
      return Number.isFinite(n) ? n : 0;
    };

    // Group by Paris-day for daily PnL series
    const dailyMap = new Map<string, { pnl: number; wins: number; losses: number }>();
    for (const r of rows) {
      const ts = new Date(r.exit_timestamp);
      // Paris day = UTC offset +1 (winter) / +2 (summer). We use simple toLocaleDateString.
      const parisDay = ts.toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
      const cur = dailyMap.get(parisDay) ?? { pnl: 0, wins: 0, losses: 0 };
      cur.pnl += pnlOf(r);
      if (r.status === TP_STATUS) cur.wins += 1;
      else if (r.status === SL_STATUS) cur.losses += 1;
      dailyMap.set(parisDay, cur);
    }

    const dailySeries = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date,
        pnl_usd: round2(v.pnl),
        wins: v.wins,
        losses: v.losses,
      }));

    // Aggregate metrics
    const tpRows = rows.filter((r) => r.status === TP_STATUS);
    const slRows = rows.filter((r) => r.status === SL_STATUS);
    const realTrades = tpRows.length + slRows.length;
    const winRatePct = realTrades > 0
      ? round2((tpRows.length / realTrades) * 100)
      : 0;

    const totalPnl = rows.reduce((s, r) => s + pnlOf(r), 0);
    const avgWin = tpRows.length > 0
      ? round2(tpRows.reduce((s, r) => s + pnlOf(r), 0) / tpRows.length)
      : 0;
    const avgLoss = slRows.length > 0
      ? round2(slRows.reduce((s, r) => s + pnlOf(r), 0) / slRows.length)
      : 0;

    const expectancyPerTrade = realTrades > 0
      ? round2((winRatePct / 100) * avgWin + (1 - winRatePct / 100) * avgLoss)
      : 0;

    const dailyPnls = dailySeries.map((d) => d.pnl_usd);
    const totalDays = dailyPnls.length;
    const profitableDays = dailyPnls.filter((p) => p > 0).length;
    const losingDays = dailyPnls.filter((p) => p < 0).length;
    const flatDays = dailyPnls.filter((p) => p === 0).length;

    const avgDailyPnl = totalDays > 0
      ? round2(dailyPnls.reduce((s, p) => s + p, 0) / totalDays)
      : 0;
    const stddev = totalDays > 0
      ? round2(Math.sqrt(
          dailyPnls.reduce((s, p) => s + Math.pow(p - avgDailyPnl, 2), 0) / totalDays
        ))
      : 0;
    const volatilityRatio = avgDailyPnl > 0
      ? round2(stddev / avgDailyPnl)
      : 999;

    const bestDay = totalDays > 0 ? round2(Math.max(...dailyPnls)) : 0;
    const worstDay = totalDays > 0 ? round2(Math.min(...dailyPnls)) : 0;

    // 7-day rolling win rate (last 7 days only)
    const last7Cutoff = Date.now() - 7 * 86_400_000;
    const last7Rows = rows.filter((r) => new Date(r.exit_timestamp).getTime() > last7Cutoff);
    const last7Tp = last7Rows.filter((r) => r.status === TP_STATUS).length;
    const last7Sl = last7Rows.filter((r) => r.status === SL_STATUS).length;
    const winRate7day = (last7Tp + last7Sl) > 0
      ? round2((last7Tp / (last7Tp + last7Sl)) * 100)
      : 0;

    // By asset class breakdown
    const acMap = new Map<string, { wins: number; losses: number; pnl: number; total: number }>();
    for (const r of rows) {
      const ac = r.asset_class ?? 'unknown';
      const cur = acMap.get(ac) ?? { wins: 0, losses: 0, pnl: 0, total: 0 };
      cur.pnl += pnlOf(r);
      cur.total += 1;
      if (r.status === TP_STATUS) cur.wins += 1;
      else if (r.status === SL_STATUS) cur.losses += 1;
      acMap.set(ac, cur);
    }
    const byAssetClass = Array.from(acMap.entries())
      .map(([asset_class, v]) => {
        const tpsl = v.wins + v.losses;
        return {
          asset_class,
          wins: v.wins,
          losses: v.losses,
          win_rate_pct: tpsl > 0 ? round2((v.wins / tpsl) * 100) : null,
          pnl_usd: round2(v.pnl),
          trades_count: v.total,
        };
      })
      .sort((a, b) => b.pnl_usd - a.pnl_usd);

    // Scaling criteria
    const profitableRatio = totalDays > 0 ? round2((profitableDays / totalDays) * 100) : 0;
    const insufficient = totalDays < 7;

    const criteria: ScalingCriterion[] = [
      {
        name: 'profitable_ratio',
        label: '% jours profitables',
        value: insufficient ? null : profitableRatio,
        target: 80,
        unit: '%',
        status: insufficient ? 'INSUFFICIENT_DATA' : (profitableRatio >= 80 ? 'PASS' : 'FAIL'),
        advice: insufficient
          ? 'Besoin de ≥ 7 jours de données pour évaluer.'
          : profitableRatio >= 80
            ? 'Edge stable, ratio jours profitables élevé.'
            : 'Edge instable — ne pas scaler le capital tant que ce ratio < 80%.',
      },
      {
        name: 'avg_daily_pnl',
        label: 'PnL moyen / jour',
        value: insufficient ? null : avgDailyPnl,
        target: 50,
        unit: 'USD',
        status: insufficient ? 'INSUFFICIENT_DATA' : (avgDailyPnl >= 50 ? 'PASS' : 'FAIL'),
        advice: insufficient
          ? 'Besoin de ≥ 7 jours de données pour évaluer.'
          : avgDailyPnl >= 50
            ? 'PnL moyen aligné avec la cible.'
            : 'Sous-performance — tuner les gates ou attendre stabilisation.',
      },
      {
        name: 'pnl_volatility_ratio',
        label: 'Volatilité (stddev/mean)',
        value: insufficient ? null : volatilityRatio,
        target: 1.0,
        unit: 'x',
        status: insufficient ? 'INSUFFICIENT_DATA' : (volatilityRatio <= 1.0 ? 'PASS' : 'FAIL'),
        advice: insufficient
          ? 'Besoin de ≥ 7 jours de données pour évaluer.'
          : volatilityRatio <= 1.0
            ? 'Volatilité maîtrisée, daily PnL prévisible.'
            : 'Trop volatile — réduire la taille des positions ou diversifier les heures.',
      },
      {
        name: 'worst_day',
        label: 'Pire journée',
        value: insufficient ? null : worstDay,
        target: -50,
        unit: 'USD',
        status: insufficient ? 'INSUFFICIENT_DATA' : (worstDay >= -50 ? 'PASS' : 'FAIL'),
        advice: insufficient
          ? 'Besoin de ≥ 7 jours de données pour évaluer.'
          : worstDay >= -50
            ? 'Drawdown intraday limité.'
            : 'Drawdown anormal — auditer la cause (chain SL, news shock, etc.).',
      },
      {
        name: 'win_rate_7day_rolling',
        label: 'Win rate 7j rolling',
        value: insufficient ? null : winRate7day,
        target: 65,
        unit: '%',
        status: insufficient
          ? 'INSUFFICIENT_DATA'
          : (winRate7day >= 65 ? 'PASS' : 'FAIL'),
        advice: insufficient
          ? 'Besoin de ≥ 7 jours de données pour évaluer.'
          : winRate7day >= 65
            ? 'Edge récent stable.'
            : 'Edge dégradé sur 7j — review les gates persistence/path/score.',
      },
    ];

    const passCount = criteria.filter((c) => c.status === 'PASS').length;
    const failCount = criteria.filter((c) => c.status === 'FAIL').length;
    const verdict: TradingStatsResponse['verdict'] = insufficient
      ? 'INSUFFICIENT_DATA'
      : passCount === 5
        ? 'READY'
        : passCount >= 3
          ? 'CAUTION'
          : 'NOT_READY';

    void failCount;

    return {
      period_days: days,
      metrics: {
        total_pnl: round2(totalPnl),
        avg_daily_pnl: avgDailyPnl,
        win_rate_pct: winRatePct,
        win_rate_7day_rolling: winRate7day,
        trades_count_total: rows.length,
        trades_tp_sl_only: realTrades,
        profitable_days: profitableDays,
        losing_days: losingDays,
        flat_days: flatDays,
        total_days: totalDays,
        pnl_stddev: stddev,
        pnl_volatility_ratio: volatilityRatio,
        best_day: bestDay,
        worst_day: worstDay,
        expectancy_per_trade: expectancyPerTrade,
        avg_win_usd: avgWin,
        avg_loss_usd: avgLoss,
      },
      scaling_criteria: criteria,
      verdict,
      by_asset_class: byAssetClass,
      daily_series: dailySeries,
      as_of: new Date().toISOString(),
    };
  }

  private emptyResponse(days: number): TradingStatsResponse {
    return {
      period_days: days,
      metrics: {
        total_pnl: 0,
        avg_daily_pnl: 0,
        win_rate_pct: 0,
        win_rate_7day_rolling: 0,
        trades_count_total: 0,
        trades_tp_sl_only: 0,
        profitable_days: 0,
        losing_days: 0,
        flat_days: 0,
        total_days: 0,
        pnl_stddev: 0,
        pnl_volatility_ratio: 0,
        best_day: 0,
        worst_day: 0,
        expectancy_per_trade: 0,
        avg_win_usd: 0,
        avg_loss_usd: 0,
      },
      scaling_criteria: [],
      verdict: 'INSUFFICIENT_DATA',
      by_asset_class: [],
      daily_series: [],
      as_of: new Date().toISOString(),
    };
  }
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
