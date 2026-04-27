import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { SupabaseService } from '../../supabase/supabase.service';
import { PerformanceEngineService } from './performance-engine.service';
import type { BotPerformanceSummary, SessionKind } from '../types/bot-lab.types';

export interface SessionMetrics {
  sessionKind: SessionKind;
  sessionValue: string;
  tradesCount: number;
  winRatePct: number;
  netPnlUsd: number;
  expectancyUsd: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
}

export interface ComparatorEntry {
  botId: string;
  botName: string;
  summary: BotPerformanceSummary | null;
  byRegime: SessionMetrics[];
  byVixBucket: SessionMetrics[];
  byAssetClass: SessionMetrics[];
}

/**
 * BotComparatorService — compare N bots côte à côte sur métriques composite
 * et par contexte (regime, VIX bucket, asset class).
 *
 * Persiste les agrégats par session dans bot_metrics_session pour cache.
 */
@Injectable()
export class BotComparatorService {
  private readonly logger = new Logger(BotComparatorService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly perfEngine: PerformanceEngineService,
  ) {}

  /**
   * Calcule + persiste les session metrics pour un bot, puis retourne
   * la struct ComparatorEntry complète.
   */
  async getEntry(botId: string): Promise<ComparatorEntry | null> {
    const { data: bot } = await this.supabase.getClient()
      .from('bot_definitions')
      .select('id, name')
      .eq('id', botId)
      .maybeSingle();

    if (!bot) return null;

    const summary = await this.perfEngine.computeSummary(botId);

    // Refresh + lit les session metrics
    await this.refreshSessionMetrics(botId);
    const sessions = await this.getSessionMetrics(botId);

    return {
      botId,
      botName: bot.name as string,
      summary,
      byRegime: sessions.filter((s) => s.sessionKind === 'market_regime'),
      byVixBucket: sessions.filter((s) => s.sessionKind === 'vix_bucket'),
      byAssetClass: sessions.filter((s) => s.sessionKind === 'asset_class'),
    };
  }

  /**
   * Compare plusieurs bots : retourne un array d'ComparatorEntry.
   */
  async compareBots(botIds: string[]): Promise<ComparatorEntry[]> {
    const entries = await Promise.all(botIds.map((id) => this.getEntry(id)));
    return entries.filter((e): e is ComparatorEntry => e !== null);
  }

  /**
   * Calcule les agrégats par session (regime / vix bucket / asset class)
   * et les upsert dans bot_metrics_session.
   */
  async refreshSessionMetrics(botId: string): Promise<void> {
    const { data: trades } = await this.supabase.getClient()
      .from('bot_paper_trades')
      .select('asset_class, market_regime, vix_at_entry, net_pnl_usd, exit_timestamp')
      .eq('bot_id', botId)
      .not('exit_timestamp', 'is', null);

    if (!trades || trades.length === 0) return;

    // Buckets : group par 3 dimensions
    const byRegime = new Map<string, Array<number>>();
    const byVix = new Map<string, Array<number>>();
    const byAsset = new Map<string, Array<number>>();

    for (const t of trades) {
      const pnl = parseFloat(String(t.net_pnl_usd ?? 0));

      if (t.market_regime) {
        const key = String(t.market_regime);
        if (!byRegime.has(key)) byRegime.set(key, []);
        byRegime.get(key)!.push(pnl);
      }

      if (t.vix_at_entry != null) {
        const bucket = this.vixToBucket(Number(t.vix_at_entry));
        if (!byVix.has(bucket)) byVix.set(bucket, []);
        byVix.get(bucket)!.push(pnl);
      }

      if (t.asset_class) {
        const key = String(t.asset_class);
        if (!byAsset.has(key)) byAsset.set(key, []);
        byAsset.get(key)!.push(pnl);
      }
    }

    const rows: Array<Record<string, unknown>> = [];
    const now = new Date().toISOString();

    const pushBucket = (kind: SessionKind, map: Map<string, number[]>) => {
      for (const [value, pnls] of map.entries()) {
        const stats = this.computeBucketStats(pnls);
        rows.push({
          bot_id: botId,
          session_kind: kind,
          session_value: value,
          trades_count: pnls.length,
          winning_trades: stats.wins,
          win_rate_pct: stats.winRate,
          avg_win_usd: stats.avgWin?.toFixed(2) ?? null,
          avg_loss_usd: stats.avgLoss?.toFixed(2) ?? null,
          net_pnl_usd: stats.netPnl.toFixed(2),
          expectancy_per_trade_usd: stats.expectancy.toFixed(2),
          profit_factor: stats.profitFactor,
          max_drawdown_pct: stats.maxDrawdown,
          sharpe_ratio: null,    // pas calculé par session (dataset trop petit souvent)
          sortino_ratio: null,
          computed_at: now,
        });
      }
    };

    pushBucket('market_regime', byRegime);
    pushBucket('vix_bucket', byVix);
    pushBucket('asset_class', byAsset);

    if (rows.length === 0) return;

    const { error } = await this.supabase.getClient()
      .from('bot_metrics_session')
      .upsert(rows, { onConflict: 'bot_id,session_kind,session_value' });

    if (error) {
      this.logger.warn(`refreshSessionMetrics upsert failed for bot=${botId.slice(0, 8)}: ${error.message}`);
    } else {
      this.logger.log(`[COMPARATOR] Refreshed ${rows.length} session metrics for bot=${botId.slice(0, 8)}`);
    }
  }

  /**
   * Lit les session metrics persistées.
   */
  async getSessionMetrics(botId: string): Promise<SessionMetrics[]> {
    const { data } = await this.supabase.getClient()
      .from('bot_metrics_session')
      .select('*')
      .eq('bot_id', botId)
      .order('session_kind, session_value', { ascending: true });

    return (data ?? []).map((r) => ({
      sessionKind: r.session_kind as SessionKind,
      sessionValue: r.session_value as string,
      tradesCount: Number(r.trades_count),
      winRatePct: Number(r.win_rate_pct ?? 0),
      netPnlUsd: parseFloat(String(r.net_pnl_usd ?? 0)),
      expectancyUsd: parseFloat(String(r.expectancy_per_trade_usd ?? 0)),
      profitFactor: r.profit_factor != null ? Number(r.profit_factor) : null,
      maxDrawdownPct: Number(r.max_drawdown_pct ?? 0),
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════

  private computeBucketStats(pnls: number[]): {
    wins: number;
    winRate: number;
    avgWin: number | null;
    avgLoss: number | null;
    netPnl: number;
    expectancy: number;
    profitFactor: number | null;
    maxDrawdown: number;
  } {
    let wins = 0;
    let losses = 0;
    let grossGains = 0;
    let grossLosses = 0;
    let netPnl = 0;
    let cumul = 0;
    let peak = 0;
    let maxDrawdown = 0;

    for (const pnl of pnls) {
      netPnl += pnl;
      cumul += pnl;
      if (cumul > peak) peak = cumul;
      const dd = peak > 0 ? ((peak - cumul) / peak) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;

      if (pnl > 0) {
        wins++;
        grossGains += pnl;
      } else if (pnl < 0) {
        losses++;
        grossLosses += Math.abs(pnl);
      }
    }

    const total = pnls.length;
    return {
      wins,
      winRate: total > 0 ? (wins / total) * 100 : 0,
      avgWin: wins > 0 ? grossGains / wins : null,
      avgLoss: losses > 0 ? -grossLosses / losses : null,
      netPnl,
      expectancy: total > 0 ? netPnl / total : 0,
      profitFactor: grossLosses > 0 ? grossGains / grossLosses : null,
      maxDrawdown,
    };
  }

  private vixToBucket(vix: number): string {
    if (vix < 15) return 'vix_low';
    if (vix < 22) return 'vix_normal';
    if (vix < 30) return 'vix_high';
    return 'vix_extreme';
  }
}
