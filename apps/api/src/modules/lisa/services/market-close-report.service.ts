/**
 * MarketCloseReportService — comparatif des 5 portfolios à chaque cloche.
 *
 * Crons UTC :
 *   - 08:00 : Asia close (Tokyo + HK fermés)
 *   - 16:30 : EU close (LSE + Euronext fermés)
 *   - 21:00 : US close (NYSE/Nasdaq fermés)
 *   - 22:00 : Daily wrap-up France (≈ 00:00 CEST été)
 *
 * Per cron : pour chaque portfolio (main + 3 shadows + trader_agent), agrège
 * les positions fermées dans la fenêtre (depuis le précédent close) et calcule
 * gross/net PnL, fees, win rate, best/worst trade, avg hold.
 *
 * Narrative Gemini Pro optionnel (MARKET_CLOSE_REPORTS_NARRATIVE=true) :
 * 3-5 phrases analyse comparative (qui gagne, pourquoi, conseil).
 *
 * Sortie : 1 row dans `market_close_reports`. Consultable via
 * /admin/market-close-reports/latest et /admin/market-close-reports?date=2026-05-26.
 *
 * Gating ENV : MARKET_CLOSE_REPORTS_ENABLED=true (default OFF).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';

type SessionKind = 'asia_close' | 'eu_close' | 'us_close' | 'daily_wrap';

const PORTFOLIOS_TO_COMPARE = [
  { id: '58439d86-3f20-4a60-82a4-307f3f252bc2', name: 'main' },
  { id: 'a0000001-0000-0000-0000-000000000001', name: 'shadow_high' },
  { id: 'a0000002-0000-0000-0000-000000000002', name: 'shadow_middle' },
  { id: 'a0000003-0000-0000-0000-000000000003', name: 'shadow_small' },
  { id: 'b0000001-0000-0000-0000-000000000001', name: 'trader_agent' },
];

const DAILY_TARGET_USD = 200;

// Fees par asset class (round-trip, en %)
const FEES_ROUND_TRIP_PCT: Record<string, number> = {
  'crypto_major': 0.20, 'crypto_alt': 0.20,
  'us_equity_large': 0.05, 'us_equity_small_mid': 0.05,
  'eu_equity': 0.20, 'asia_equity': 0.20,
};

interface PortfolioBreakdown {
  portfolio_id: string;
  name: string;
  closed_count: number;
  wins: number;
  losses: number;
  gross_pnl_usd: number;
  fees_usd: number;
  net_pnl_usd: number;
  win_rate_pct: number | null;
  avg_pnl_per_trade_usd: number | null;
  best_trade: { symbol: string; pnl: number } | null;
  worst_trade: { symbol: string; pnl: number } | null;
  avg_hold_minutes: number | null;
}

@Injectable()
export class MarketCloseReportService {
  private readonly logger = new Logger(MarketCloseReportService.name);
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llmRouter: ScannerLlmRouterService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('MARKET_CLOSE_REPORTS_ENABLED') ?? 'false')
      .toLowerCase() === 'true';
    if (this.enabled) {
      this.logger.log('[market-close-reports] ENABLED — crons 08:00, 16:30, 21:00, 22:00 UTC');
    }
  }

  @Cron('0 8 * * *', { name: 'market-close-asia', timeZone: 'UTC' })
  async runAsiaClose(): Promise<void> { await this.runSessionReport('asia_close'); }

  @Cron('30 16 * * *', { name: 'market-close-eu', timeZone: 'UTC' })
  async runEuClose(): Promise<void> { await this.runSessionReport('eu_close'); }

  @Cron('0 21 * * *', { name: 'market-close-us', timeZone: 'UTC' })
  async runUsClose(): Promise<void> { await this.runSessionReport('us_close'); }

  @Cron('0 22 * * *', { name: 'market-close-daily-wrap', timeZone: 'UTC' })
  async runDailyWrap(): Promise<void> { await this.runSessionReport('daily_wrap'); }

  // ====================================================================
  // Core
  // ====================================================================
  private async runSessionReport(session: SessionKind): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;

    const now = new Date();
    const { windowStart, windowEnd } = this.computeWindow(session, now);
    this.logger.log(
      `[market-close-reports] ${session} — window ${windowStart.toISOString()} → ${windowEnd.toISOString()}`,
    );

    try {
      // Agrège par portfolio
      const breakdown: PortfolioBreakdown[] = [];
      for (const pf of PORTFOLIOS_TO_COMPARE) {
        const row = await this.aggregatePortfolio(pf.id, pf.name, windowStart, windowEnd);
        breakdown.push(row);
      }

      const totalNetPnl = breakdown.reduce((s, b) => s + b.net_pnl_usd, 0);
      const totalClosed = breakdown.reduce((s, b) => s + b.closed_count, 0);

      // Winner / loser (par net_pnl)
      const sorted = [...breakdown].sort((a, b) => b.net_pnl_usd - a.net_pnl_usd);
      const winner = sorted[0]?.net_pnl_usd > 0 ? sorted[0] : null;
      const loser = sorted[sorted.length - 1]?.net_pnl_usd < 0
        ? sorted[sorted.length - 1]
        : null;

      // Narrative Gemini optionnel
      let narrative: string | undefined;
      let aiProvider: string | undefined;
      let aiCost = 0;
      const narrativeEnabled = (this.config.get<string>('MARKET_CLOSE_REPORTS_NARRATIVE') ?? 'false')
        .toLowerCase() === 'true';
      if (narrativeEnabled && this.llmRouter.isEnabled()) {
        try {
          const response = await this.llmRouter.call({
            system: this.buildNarrativePrompt(session),
            user: JSON.stringify({ session, window_start: windowStart, window_end: windowEnd, breakdown, total_net_pnl_usd: totalNetPnl, daily_target_usd: DAILY_TARGET_USD }, null, 2),
            temperature: 0.4,
            maxTokens: 400,
            timeoutMs: 10_000,
          });
          narrative = response.content.trim();
          aiProvider = response.providerId;
          aiCost = response.costUsd;
        } catch (e) {
          this.logger.warn(`[market-close-reports] narrative failed: ${String(e).slice(0, 150)}`);
        }
      }

      // Persist
      const { error } = await this.supabase.getClient()
        .from('market_close_reports')
        .insert({
          session_kind: session,
          window_start: windowStart.toISOString(),
          window_end: windowEnd.toISOString(),
          portfolio_breakdown: breakdown,
          total_net_pnl_usd: totalNetPnl.toFixed(2),
          total_closed_count: totalClosed,
          winner_portfolio_id: winner?.portfolio_id ?? null,
          loser_portfolio_id: loser?.portfolio_id ?? null,
          target_progress_pct: ((totalNetPnl / DAILY_TARGET_USD) * 100).toFixed(2),
          ai_narrative: narrative ?? null,
          ai_provider: aiProvider ?? null,
          ai_cost_usd: aiCost,
        });

      if (error) {
        this.logger.error(`[market-close-reports] insert failed: ${error.message}`);
        return;
      }

      // Summary log
      const summary = breakdown
        .map((b) => `${b.name}=$${b.net_pnl_usd.toFixed(2)} (${b.closed_count}cl)`)
        .join(' | ');
      this.logger.log(
        `[market-close-reports] ${session} done — total net $${totalNetPnl.toFixed(2)} (${totalClosed} trades) — ${summary}` +
          (winner ? ` — 🏆 winner=${winner.name}` : '') +
          (narrative ? ` — AI narrative ✅` : ''),
      );
    } catch (e) {
      this.logger.error(`[market-close-reports] ${session} failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async aggregatePortfolio(
    portfolioId: string,
    name: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<PortfolioBreakdown> {
    const { data } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('symbol, asset_class, realized_pnl_usd, entry_notional_usd, entry_timestamp, exit_timestamp, exit_reason')
      .eq('portfolio_id', portfolioId)
      .gte('exit_timestamp', windowStart.toISOString())
      .lt('exit_timestamp', windowEnd.toISOString())
      .neq('status', 'open');

    const closed = (data ?? []) as Array<{
      symbol: string; asset_class: string;
      realized_pnl_usd: string | number;
      entry_notional_usd: string | number;
      entry_timestamp: string; exit_timestamp: string;
      exit_reason: string;
    }>;

    let grossPnl = 0;
    let fees = 0;
    let wins = 0;
    let losses = 0;
    let best: { symbol: string; pnl: number } | null = null;
    let worst: { symbol: string; pnl: number } | null = null;
    let totalHoldMin = 0;

    for (const c of closed) {
      const pnl = Number(c.realized_pnl_usd ?? 0);
      grossPnl += pnl;
      if (pnl > 0) wins++; else if (pnl < 0) losses++;
      if (!best || pnl > best.pnl) best = { symbol: c.symbol, pnl };
      if (!worst || pnl < worst.pnl) worst = { symbol: c.symbol, pnl };

      const notional = Number(c.entry_notional_usd ?? 0);
      const feesPct = FEES_ROUND_TRIP_PCT[c.asset_class] ?? 0.15;
      fees += (notional * feesPct) / 100;

      const holdMs = new Date(c.exit_timestamp).getTime() - new Date(c.entry_timestamp).getTime();
      totalHoldMin += Math.max(0, holdMs / 60_000);
    }

    return {
      portfolio_id: portfolioId,
      name,
      closed_count: closed.length,
      wins, losses,
      gross_pnl_usd: Number(grossPnl.toFixed(2)),
      fees_usd: Number(fees.toFixed(2)),
      net_pnl_usd: Number((grossPnl - fees).toFixed(2)),
      win_rate_pct: closed.length > 0 ? Number(((wins / closed.length) * 100).toFixed(2)) : null,
      avg_pnl_per_trade_usd: closed.length > 0 ? Number((grossPnl / closed.length).toFixed(2)) : null,
      best_trade: best,
      worst_trade: worst,
      avg_hold_minutes: closed.length > 0 ? Number((totalHoldMin / closed.length).toFixed(1)) : null,
    };
  }

  private computeWindow(session: SessionKind, now: Date): { windowStart: Date; windowEnd: Date } {
    const dayStartUtc = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
    const yesterdayStartUtc = new Date(dayStartUtc.getTime() - 24 * 60 * 60_000);
    const previousAsiaCloseUtc = new Date(`${now.toISOString().slice(0, 10)}T08:00:00Z`);
    const previousEuCloseUtc = new Date(`${now.toISOString().slice(0, 10)}T16:30:00Z`);
    const previousUsCloseUtc = new Date(`${now.toISOString().slice(0, 10)}T21:00:00Z`);

    switch (session) {
      case 'asia_close':
        // Window : depuis EU close yesterday → maintenant (Asia est trading depuis la nuit)
        return { windowStart: new Date(yesterdayStartUtc.getTime() + 16.5 * 60 * 60_000), windowEnd: now };
      case 'eu_close':
        // Window : depuis Asia close du jour
        return { windowStart: previousAsiaCloseUtc, windowEnd: now };
      case 'us_close':
        // Window : depuis EU close du jour
        return { windowStart: previousEuCloseUtc, windowEnd: now };
      case 'daily_wrap':
        // Window : journée complète UTC
        return { windowStart: dayStartUtc, windowEnd: now };
    }
  }

  private buildNarrativePrompt(session: SessionKind): string {
    const sessionLabel = {
      asia_close: 'la cloche Asia (Tokyo/HK)',
      eu_close: 'la cloche EU (LSE/Euronext)',
      us_close: 'la cloche US (NYSE/Nasdaq)',
      daily_wrap: 'le wrap-up quotidien (fin de session US, soir France)',
    }[session];

    return `Tu es un analyste portfolio multi-strategy. Analyse le comparatif des 5 portfolios SmartVest paper-trading à ${sessionLabel}.

Les 5 portfolios bench :
- "main" : portfolio principal (capital $10.5k, sizing 7.5%/pos, mode mixed)
- "shadow_high" : 3 positions × $3500 (concentré)
- "shadow_middle" : 15 positions × $700 (équilibré)
- "shadow_small" : 20 positions × $525 (diversifié)
- "trader_agent" : portfolio dédié $10k piloté par Gemini Pro autonome (cron 5min)

Cible $200/jour total.

Tâche : 3-5 phrases d'analyse comparative en français. Précis sur les chiffres. Identifie :
1. Le gagnant de la session + pourquoi (sizing, tickers, timing)
2. Le perdant + cause (overtrading ? fees ratio ? wrong direction ?)
3. Une observation actionnable pour la session suivante

PAS DE MARKDOWN, juste du texte clair. Cite les nombres réels.`;
  }

  // ====================================================================
  // PUBLIC API
  // ====================================================================
  async getLatest(): Promise<object | null> {
    const { data } = await this.supabase.getClient()
      .from('market_close_reports')
      .select('*')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ?? null;
  }

  async getByDate(date: string): Promise<object[]> {
    const dayStart = `${date}T00:00:00Z`;
    const dayEnd = `${date}T23:59:59Z`;
    const { data } = await this.supabase.getClient()
      .from('market_close_reports')
      .select('*')
      .gte('captured_at', dayStart)
      .lte('captured_at', dayEnd)
      .order('captured_at', { ascending: true });
    return (data ?? []) as object[];
  }

  /** Manual trigger pour tester sans attendre le cron. */
  async runManualTrigger(session: SessionKind): Promise<void> {
    await this.runSessionReport(session);
  }
}
