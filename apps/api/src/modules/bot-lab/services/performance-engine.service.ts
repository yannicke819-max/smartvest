import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { SupabaseService } from '../../supabase/supabase.service';
import type {
  BotPerformanceSummary,
  BotPaperTrade,
} from '../types/bot-lab.types';
import { BOT_LAB_CONSTANTS } from '../types/bot-lab.types';

/**
 * PerformanceEngineService — calcule les métriques standardisées d'un bot.
 *
 * Métriques produites (BotPerformanceSummary) :
 *   - Sharpe Ratio (returns journaliers vs risk-free 4%, annualisé)
 *   - Sortino Ratio (downside deviation seulement)
 *   - Max Drawdown peak-to-trough (% du peak)
 *   - Recovery Days (jours pour repasser le précédent peak)
 *   - Profit Factor (gross gains / gross losses)
 *   - Expectancy ($ moyen par trade, brut net coûts)
 *   - Win Rate, Avg Win, Avg Loss
 *   - Largest Win / Largest Loss
 *   - Consecutive Wins/Losses Max
 *   - CAGR si historique > 90 jours
 *
 * Pure compute (lit DB, calcule, retourne) — pas d'écriture. L'écriture
 * est responsabilité de EquityCurveService.refreshDaily() qui appelle
 * ce service puis upsert dans bot_metrics_daily.
 */
@Injectable()
export class PerformanceEngineService {
  private readonly logger = new Logger(PerformanceEngineService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Calcule le summary complet d'un bot.
   * Renvoie null si moins de MIN_TRADES_FOR_EVALUATION trades fermés.
   */
  async computeSummary(botId: string): Promise<BotPerformanceSummary | null> {
    const { data: trades } = await this.supabase.getClient()
      .from('bot_paper_trades')
      .select('*')
      .eq('bot_id', botId)
      .not('exit_timestamp', 'is', null)
      .order('exit_timestamp', { ascending: true });

    if (!trades || trades.length < BOT_LAB_CONSTANTS.MIN_TRADES_FOR_EVALUATION) {
      this.logger.debug(`[PERF] bot=${botId.slice(0, 8)} trades insuffisants (${trades?.length ?? 0} < ${BOT_LAB_CONSTANTS.MIN_TRADES_FOR_EVALUATION})`);
      return null;
    }

    return this.computeFromTrades(botId, trades as unknown as Array<Record<string, unknown>>);
  }

  /**
   * Variante exposée pour les tests + comparator (utilise des trades pré-chargés).
   */
  computeFromTrades(botId: string, tradesRaw: Array<Record<string, unknown>>): BotPerformanceSummary {
    const trades = tradesRaw.map((t) => ({
      entryTimestamp: t.entry_timestamp as string,
      exitTimestamp: t.exit_timestamp as string,
      netPnlUsd: parseFloat(String(t.net_pnl_usd ?? 0)),
      netPnlPct: Number(t.net_pnl_pct ?? 0),
      entryNotionalUsd: parseFloat(String(t.entry_notional_usd ?? 0)),
    }));

    // ── Aggregates de base ──────────────────────────────────────────
    let netPnlUsd = 0;
    let grossGains = 0;
    let grossLosses = 0;
    let wins = 0;
    let losses = 0;
    let largestWin = 0;
    let largestLoss = 0;
    let consecWins = 0;
    let consecLosses = 0;
    let consecWinsMax = 0;
    let consecLossesMax = 0;

    for (const t of trades) {
      netPnlUsd += t.netPnlUsd;
      if (t.netPnlUsd > 0) {
        wins++;
        grossGains += t.netPnlUsd;
        largestWin = Math.max(largestWin, t.netPnlUsd);
        consecWins++;
        consecLosses = 0;
        consecWinsMax = Math.max(consecWinsMax, consecWins);
      } else if (t.netPnlUsd < 0) {
        losses++;
        grossLosses += Math.abs(t.netPnlUsd);
        largestLoss = Math.min(largestLoss, t.netPnlUsd);
        consecLosses++;
        consecWins = 0;
        consecLossesMax = Math.max(consecLossesMax, consecLosses);
      }
    }

    const totalTrades = trades.length;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const avgWin = wins > 0 ? grossGains / wins : 0;
    const avgLoss = losses > 0 ? -grossLosses / losses : 0;
    const profitFactor = grossLosses > 0 ? grossGains / grossLosses : (grossGains > 0 ? Infinity : null);
    const expectancyPerTrade = totalTrades > 0 ? netPnlUsd / totalTrades : 0;

    // ── Returns journaliers pour Sharpe/Sortino ─────────────────────
    const dailyReturns = this.aggregateDailyReturns(trades);
    const sharpe = this.computeSharpe(dailyReturns);
    const sortino = this.computeSortino(dailyReturns);

    // ── Drawdown peak-to-trough ─────────────────────────────────────
    const { maxDrawdownPct, recoveryDays } = this.computeMaxDrawdown(trades);

    // ── Total days + CAGR ───────────────────────────────────────────
    const firstDate = new Date(trades[0].entryTimestamp);
    const lastDate = new Date(trades[trades.length - 1].exitTimestamp);
    const totalDays = Math.max(1, Math.round((lastDate.getTime() - firstDate.getTime()) / 86_400_000));

    let cagr: number | null = null;
    let netReturnPct = 0;
    if (trades.length > 0) {
      const firstNotional = trades[0].entryNotionalUsd;
      // Simple : netReturnPct = netPnl / capital initial estimé.
      // Capital initial estimé = max notional jamais déployé (proxy)
      const maxNotionalUsed = Math.max(...trades.map((t) => t.entryNotionalUsd));
      const referenceCapital = Math.max(firstNotional, maxNotionalUsed);
      netReturnPct = referenceCapital > 0 ? (netPnlUsd / referenceCapital) * 100 : 0;

      if (totalDays >= 90) {
        const yearsFraction = totalDays / 365;
        const totalMultiple = 1 + netReturnPct / 100;
        if (totalMultiple > 0) {
          cagr = (Math.pow(totalMultiple, 1 / yearsFraction) - 1) * 100;
        }
      }
    }

    return {
      botId,
      totalTrades,
      totalDays,
      netPnlUsd,
      netReturnPct,
      cagr,
      sharpeRatio: sharpe,
      sortinoRatio: sortino,
      maxDrawdownPct,
      recoveryDays,
      profitFactor: profitFactor === Infinity ? null : profitFactor,
      expectancyPerTradeUsd: expectancyPerTrade,
      winRatePct: winRate,
      avgWinUsd: avgWin,
      avgLossUsd: avgLoss,
      largestWinUsd: largestWin,
      largestLossUsd: largestLoss,
      consecutiveWinsMax: consecWinsMax,
      consecutiveLossesMax: consecLossesMax,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // CALCULS INTERNES (purs)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Agrège les PnL trade par trade en returns journaliers.
   * Un return journalier = (sum PnL day) / capital_de_reference.
   */
  private aggregateDailyReturns(
    trades: Array<{ exitTimestamp: string; netPnlUsd: number; entryNotionalUsd: number }>,
  ): number[] {
    if (trades.length === 0) return [];

    // Capital reference = max notional sur la fenêtre (proxy stable)
    const referenceCapital = Math.max(...trades.map((t) => t.entryNotionalUsd));
    if (referenceCapital <= 0) return [];

    // Group PnL par date de sortie (YYYY-MM-DD)
    const dailyMap = new Map<string, number>();
    for (const t of trades) {
      const date = t.exitTimestamp.slice(0, 10);
      dailyMap.set(date, (dailyMap.get(date) ?? 0) + t.netPnlUsd);
    }

    return Array.from(dailyMap.values()).map((pnl) => (pnl / referenceCapital) * 100);
  }

  /**
   * Sharpe ratio annualisé.
   *   Sharpe = (mean(returns) - rf_daily) / std(returns) × sqrt(252)
   *
   * Returns null si moins de 5 returns ou std nulle.
   */
  private computeSharpe(dailyReturnsPct: number[]): number | null {
    if (dailyReturnsPct.length < 5) return null;
    const rfDaily = BOT_LAB_CONSTANTS.RISK_FREE_RATE_PCT / 252;
    const excessReturns = dailyReturnsPct.map((r) => r - rfDaily);
    const mean = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;
    const variance = excessReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / excessReturns.length;
    const std = Math.sqrt(variance);
    if (std === 0) return null;
    return (mean / std) * Math.sqrt(252);
  }

  /**
   * Sortino ratio — variant Sharpe utilisant uniquement la downside deviation.
   *   Sortino = (mean(returns) - rf_daily) / downside_std × sqrt(252)
   */
  private computeSortino(dailyReturnsPct: number[]): number | null {
    if (dailyReturnsPct.length < 5) return null;
    const rfDaily = BOT_LAB_CONSTANTS.RISK_FREE_RATE_PCT / 252;
    const excessReturns = dailyReturnsPct.map((r) => r - rfDaily);
    const mean = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;

    // Downside : returns NÉGATIFS uniquement
    const downsides = excessReturns.filter((r) => r < 0);
    if (downsides.length === 0) return null;

    const downsideVar = downsides.reduce((sum, r) => sum + r * r, 0) / excessReturns.length;
    const downsideStd = Math.sqrt(downsideVar);
    if (downsideStd === 0) return null;

    return (mean / downsideStd) * Math.sqrt(252);
  }

  /**
   * Max Drawdown peak-to-trough en % du peak + nombre de jours pour recovery.
   * Calculé sur l'equity curve cumulative des trades.
   */
  private computeMaxDrawdown(
    trades: Array<{ exitTimestamp: string; netPnlUsd: number }>,
  ): { maxDrawdownPct: number; recoveryDays: number | null } {
    let cumulPnl = 0;
    let peak = 0;
    let maxDrawdown = 0;
    let maxDrawdownDate: string | null = null;
    let lastPeakBeforeMaxDD: string | null = null;

    for (const t of trades) {
      cumulPnl += t.netPnlUsd;
      if (cumulPnl > peak) {
        peak = cumulPnl;
        lastPeakBeforeMaxDD = t.exitTimestamp;
      }
      const drawdown = peak > 0 ? ((peak - cumulPnl) / peak) * 100 : 0;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownDate = t.exitTimestamp;
      }
    }

    // Recovery : combien de jours après le trough avant de dépasser le peak ?
    let recoveryDays: number | null = null;
    if (maxDrawdownDate && lastPeakBeforeMaxDD) {
      // Cherche le 1er trade après maxDrawdownDate où cumulPnl > peak
      cumulPnl = 0;
      let currentPeak = 0;
      let recoveryReached = false;
      const ddDate = new Date(maxDrawdownDate);
      for (const t of trades) {
        cumulPnl += t.netPnlUsd;
        if (cumulPnl > currentPeak) currentPeak = cumulPnl;
        const tDate = new Date(t.exitTimestamp);
        if (tDate > ddDate && cumulPnl >= peak) {
          recoveryDays = Math.round((tDate.getTime() - ddDate.getTime()) / 86_400_000);
          recoveryReached = true;
          break;
        }
      }
      if (!recoveryReached) recoveryDays = null; // jamais récupéré
    }

    return { maxDrawdownPct: maxDrawdown, recoveryDays };
  }
}
