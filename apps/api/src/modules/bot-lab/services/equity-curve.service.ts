import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

export interface EquityCurvePoint {
  date: string;            // YYYY-MM-DD
  cumulativePnlUsd: number;
  equityValueUsd: number;
  dailyReturnPct: number | null;
  drawdownFromPeakPct: number;
  isNewPeak: boolean;
  tradesCount: number;
  winningTrades: number;
  losingTrades: number;
  totalCostsUsd: number;
}

/**
 * EquityCurveService — génère et persiste la courbe equity jour par jour
 * pour un bot.
 *
 * Lit `bot_paper_trades` (trades fermés uniquement) → groupe par date de
 * sortie → calcule cumulative PnL + equity + drawdown peak-to-trough →
 * upsert dans `bot_metrics_daily`.
 *
 * Idempotent : ré-appelable à volonté, recalcule depuis zéro à chaque fois.
 * Coût : O(N log N) tri + O(N) compute + N upserts.
 */
@Injectable()
export class EquityCurveService {
  private readonly logger = new Logger(EquityCurveService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Calcule la courbe equity pour un bot et la persiste dans bot_metrics_daily.
   *
   * @param botId
   * @param capitalBaseUsd Capital de référence du bot (depuis bot_definitions)
   * @returns nombre de jours générés
   */
  async refreshDaily(botId: string, capitalBaseUsd: number): Promise<{ daysGenerated: number; finalEquity: number; finalCumulPnl: number }> {
    // 1. Récupère tous les trades fermés du bot
    const { data: tradesData } = await this.supabase.getClient()
      .from('bot_paper_trades')
      .select('exit_timestamp, net_pnl_usd, entry_cost_usd, exit_cost_usd')
      .eq('bot_id', botId)
      .not('exit_timestamp', 'is', null)
      .order('exit_timestamp', { ascending: true });

    if (!tradesData || tradesData.length === 0) {
      return { daysGenerated: 0, finalEquity: capitalBaseUsd, finalCumulPnl: 0 };
    }

    // 2. Group par date de sortie (YYYY-MM-DD)
    const dailyMap = new Map<string, {
      pnlUsd: number;
      tradesCount: number;
      winningTrades: number;
      losingTrades: number;
      totalCostsUsd: number;
    }>();

    for (const t of tradesData) {
      const date = String(t.exit_timestamp).slice(0, 10);
      const pnl = parseFloat(String(t.net_pnl_usd ?? 0));
      const entryCost = parseFloat(String(t.entry_cost_usd ?? 0));
      const exitCost = parseFloat(String(t.exit_cost_usd ?? 0));
      const existing = dailyMap.get(date) ?? {
        pnlUsd: 0, tradesCount: 0, winningTrades: 0, losingTrades: 0, totalCostsUsd: 0,
      };
      existing.pnlUsd += pnl;
      existing.tradesCount += 1;
      if (pnl > 0) existing.winningTrades += 1;
      else if (pnl < 0) existing.losingTrades += 1;
      existing.totalCostsUsd += entryCost + exitCost;
      dailyMap.set(date, existing);
    }

    // 3. Trier par date + compute cumulative + drawdown
    const sortedDates = Array.from(dailyMap.keys()).sort();
    const points: EquityCurvePoint[] = [];
    let cumulPnl = 0;
    let peak = 0;
    let prevEquity = capitalBaseUsd;

    for (const date of sortedDates) {
      const dayData = dailyMap.get(date)!;
      cumulPnl += dayData.pnlUsd;
      const equity = capitalBaseUsd + cumulPnl;
      const dailyReturn = prevEquity > 0
        ? ((equity - prevEquity) / prevEquity) * 100
        : null;
      const isNewPeak = cumulPnl > peak;
      if (isNewPeak) peak = cumulPnl;
      const drawdownFromPeak = peak > 0 ? ((peak - cumulPnl) / Math.abs(peak + capitalBaseUsd)) * 100 : 0;

      points.push({
        date,
        cumulativePnlUsd: cumulPnl,
        equityValueUsd: equity,
        dailyReturnPct: dailyReturn,
        drawdownFromPeakPct: drawdownFromPeak,
        isNewPeak,
        tradesCount: dayData.tradesCount,
        winningTrades: dayData.winningTrades,
        losingTrades: dayData.losingTrades,
        totalCostsUsd: dayData.totalCostsUsd,
      });
      prevEquity = equity;
    }

    // 4. Upsert en batch dans bot_metrics_daily
    const rows = points.map((p) => ({
      bot_id: botId,
      date: p.date,
      trades_count: p.tradesCount,
      winning_trades: p.winningTrades,
      losing_trades: p.losingTrades,
      realized_pnl_usd: dailyMap.get(p.date)!.pnlUsd.toFixed(2),
      cumulative_pnl_usd: p.cumulativePnlUsd.toFixed(2),
      equity_value_usd: p.equityValueUsd.toFixed(2),
      daily_return_pct: p.dailyReturnPct,
      drawdown_from_peak_pct: p.drawdownFromPeakPct,
      is_new_peak: p.isNewPeak,
      total_costs_usd: p.totalCostsUsd.toFixed(2),
      computed_at: new Date().toISOString(),
    }));

    const { error } = await this.supabase.getClient()
      .from('bot_metrics_daily')
      .upsert(rows, { onConflict: 'bot_id,date' });

    if (error) {
      this.logger.warn(`refreshDaily upsert failed for bot=${botId.slice(0, 8)}: ${error.message}`);
    } else {
      this.logger.log(`[EQUITY] Refreshed ${rows.length} days for bot=${botId.slice(0, 8)}`);
    }

    return {
      daysGenerated: rows.length,
      finalEquity: prevEquity,
      finalCumulPnl: cumulPnl,
    };
  }

  /**
   * Lit la courbe equity persistée (pour l'UI).
   */
  async getCurve(botId: string, limit = 365): Promise<EquityCurvePoint[]> {
    const { data } = await this.supabase.getClient()
      .from('bot_metrics_daily')
      .select('*')
      .eq('bot_id', botId)
      .order('date', { ascending: true })
      .limit(limit);

    return (data ?? []).map((r) => ({
      date: r.date as string,
      cumulativePnlUsd: parseFloat(String(r.cumulative_pnl_usd)),
      equityValueUsd: parseFloat(String(r.equity_value_usd)),
      dailyReturnPct: r.daily_return_pct as number | null,
      drawdownFromPeakPct: parseFloat(String(r.drawdown_from_peak_pct ?? 0)),
      isNewPeak: r.is_new_peak as boolean,
      tradesCount: Number(r.trades_count),
      winningTrades: Number(r.winning_trades),
      losingTrades: Number(r.losing_trades),
      totalCostsUsd: parseFloat(String(r.total_costs_usd ?? 0)),
    }));
  }
}
