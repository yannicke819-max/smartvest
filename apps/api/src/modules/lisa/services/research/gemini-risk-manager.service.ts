/**
 * Gemini Risk Manager — exit-side LLM thesis integrity check.
 *
 * Hypothèse (audit 23/05) : 94 stops historiques mean -2.63 % = -$3,503 sum.
 * Si Gemini sort 30 % d'entre eux 0.5 % plus tôt sur lecture news/macro live,
 * c'est ~+$525 économisés sur sample = +$3,000-5,000/an annualisé.
 *
 * Approche INVERSÉE : pas un signal d'entrée (saturé sur retail momentum),
 * mais un signal de SORTIE prématurée quand la thèse est cassée.
 *
 * Architecture :
 *   - Cron toutes les 5 min : pour chaque position ouverte, fetch 60min news+macro
 *   - Appel Gemini Flash Lite : "thèse encore valide ? yes/no + raison"
 *   - Si no → écrit decision_log kind='risk_manager_thesis_broken'
 *   - V2 AUTO : ferme automatiquement si confidence >= GEMINI_RISK_MANAGER_AUTO_CLOSE_MIN_CONFIDENCE
 *
 * Coût : $0.0001 × 12/h × 24h × 3 positions = $0.09/jour max
 *
 * Gating : GEMINI_RISK_MANAGER_ENABLED (default false). Sans flag, no-op.
 * Auto-close : GEMINI_RISK_MANAGER_AUTO_CLOSE_MIN_CONFIDENCE (default 0.8).
 *   Mettre à 1.1 pour désactiver l'auto-close tout en gardant le log.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../../supabase/supabase.service';
import { ScannerLlmRouterService } from '../scanner-llm-router.service';
import { EodhdNewsService } from '../eodhd-news.service';
import { EodhdEnrichmentService, type EodhdNewsItem } from '../eodhd-enrichment.service';
import { parseLlmJson } from '../llm-json-parser.helper';
import { MechanicalTradingService } from '../mechanical-trading.service';

export type ThesisVerdict = 'valid' | 'broken' | 'unclear';

export interface RiskAssessment {
  positionId: string;
  symbol: string;
  verdict: ThesisVerdict;
  confidence: number; // 0..1
  reason: string;
  newsCount: number;
  llmCostUsd: number;
  autoClosed: boolean;
}

const SYSTEM_PROMPT = `You are a risk manager for an automated momentum trading system.
You evaluate if the original thesis behind an OPEN long position is still valid given recent news/events.

Output STRICT JSON only:
{
  "verdict": "valid" | "broken" | "unclear",
  "confidence": 0.0-1.0,
  "reason": "short sentence max 80 chars"
}

Rules:
- "broken" = clear negative catalyst (downgrade, profit warning, regulatory action, sector rout)
- "unclear" = mixed signals or no fresh news
- "valid" = positive or neutral context, no break in original thesis
- Be conservative on "broken" (false positives = early exits = losses)
- confidence < 0.7 should default to "unclear"`;

@Injectable()
export class GeminiRiskManagerService {
  private readonly logger = new Logger(GeminiRiskManagerService.name);
  private readonly enabled: boolean;
  private readonly autoCloseMinConfidence: number;
  private readonly useMacroNews: boolean;
  /** Cache 5 min des news macro globales — partagé pour toutes les positions du cycle. */
  private macroNewsCache: { data: EodhdNewsItem[]; asOf: number } | null = null;
  private readonly MACRO_NEWS_CACHE_MS = 5 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llm: ScannerLlmRouterService,
    private readonly eodhdNews: EodhdNewsService,
    private readonly eodhdEnrichment: EodhdEnrichmentService,
    private readonly mechanical: MechanicalTradingService,
  ) {
    this.enabled = (this.config.get<string>('GEMINI_RISK_MANAGER_ENABLED') ?? 'false').toLowerCase() === 'true';
    const rawConf = parseFloat(this.config.get<string>('GEMINI_RISK_MANAGER_AUTO_CLOSE_MIN_CONFIDENCE') ?? '0.8');
    this.autoCloseMinConfidence = Number.isFinite(rawConf) && rawConf >= 0 && rawConf <= 1.1 ? rawConf : 0.8;
    this.useMacroNews = (this.config.get<string>('GEMINI_RISK_MANAGER_USE_MACRO_NEWS') ?? 'false').toLowerCase() === 'true';
    if (this.enabled) {
      this.logger.log(
        `[risk-manager] V2 ENABLED — auto-close seuil conf>=${this.autoCloseMinConfidence} — macro=${this.useMacroNews} — cron */5min`,
      );
    }
  }

  /**
   * Pull les news macro globales (sans symbol) avec cache 5 min.
   * Filtre : sentiment négatif OU mots-clés geopolitical/macro (Fed, CPI, Iran,
   * Hormuz, oil, etc.) car ce sont les seules pertinentes pour casser une thèse.
   */
  private async getMacroNews(): Promise<EodhdNewsItem[]> {
    if (!this.useMacroNews) return [];
    if (this.macroNewsCache && Date.now() - this.macroNewsCache.asOf < this.MACRO_NEWS_CACHE_MS) {
      return this.macroNewsCache.data;
    }
    try {
      const all = await this.eodhdEnrichment.fetchRecentNews(undefined, 30);
      const MACRO_KEYWORDS = /\b(fed|fomc|cpi|nfp|gdp|ecb|boe|boj|inflation|recession|tariff|iran|hormuz|opec|oil|brent|wti|gold|war|sanctions|geopolitic|china|trade war|yields?|treasur)\b/i;
      const filtered = all.filter((n) => {
        const isNegative = typeof n.sentiment === 'number' && n.sentiment < -0.2;
        const isMacro = MACRO_KEYWORDS.test(`${n.title} ${n.contentPreview ?? ''}`);
        return isNegative || isMacro;
      }).slice(0, 8);
      this.macroNewsCache = { data: filtered, asOf: Date.now() };
      return filtered;
    } catch (e) {
      this.logger.warn(`[risk-manager] macro news fetch failed: ${String(e).slice(0, 200)}`);
      return [];
    }
  }

  /** Cron toutes les 5 min — eval thèse pour chaque position open. */
  @Cron('*/5 * * * *')
  async cronEvalOpenPositions(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    try {
      const positions = await this.fetchOpenPositions();
      if (positions.length === 0) return;
      // Pré-fetch news macro 1× pour tout le cycle (cache 5 min, partagé)
      if (this.useMacroNews) await this.getMacroNews();
      this.logger.log(`[risk-manager] eval ${positions.length} open positions`);
      for (const pos of positions) {
        await this.assessThesis(pos).catch((e) => {
          this.logger.warn(`[risk-manager] ${pos.symbol} assessment failed: ${String(e).slice(0, 200)}`);
        });
      }
    } catch (e) {
      this.logger.warn(`[risk-manager] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async fetchOpenPositions(): Promise<Array<{ id: string; symbol: string; asset_class: string; entry_timestamp: string; entry_price: number }>> {
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('id, symbol, asset_class, entry_timestamp, entry_price')
      .eq('status', 'open')
      .limit(20);
    if (error || !data) return [];
    return data as Array<{ id: string; symbol: string; asset_class: string; entry_timestamp: string; entry_price: number }>;
  }

  async assessThesis(pos: { id: string; symbol: string; asset_class: string; entry_timestamp: string }): Promise<RiskAssessment | null> {
    const news = await this.eodhdNews.getRecentNewsForTicker(pos.symbol, 1).catch(() => []);
    const macroNews = await this.getMacroNews();

    const tickerBlock = news.length > 0
      ? news.slice(0, 5).map((n) => {
          const pol = typeof n.sentiment_polarity === 'number' ? `pol=${n.sentiment_polarity.toFixed(2)}` : '';
          return `- ${n.title.slice(0, 100)} ${pol}`;
        }).join('\n')
      : '(no ticker-specific news)';

    const macroBlock = macroNews.length > 0
      ? macroNews.slice(0, 6).map((n) => {
          const sent = typeof n.sentiment === 'number' ? `sent=${n.sentiment.toFixed(2)}` : '';
          return `- ${n.title.slice(0, 110)} ${sent}`;
        }).join('\n')
      : '(no macro/geopolitical news)';

    const ageMin = Math.floor((Date.now() - new Date(pos.entry_timestamp).getTime()) / 60_000);
    const userPrompt =
      `Open long position: ${pos.symbol} (${pos.asset_class}), opened ${ageMin}min ago.\n\n` +
      `Ticker news (last 60min):\n${tickerBlock}\n\n` +
      `Macro / geopolitical news (last 60min, global feed):\n${macroBlock}\n\n` +
      `Is the original momentum thesis still valid? A macro shock (Fed, oil, Iran/Hormuz, tariffs) ` +
      `that directly impacts the position's asset class should be treated as broken with confidence>=0.8. ` +
      `Output strict JSON only.`;

    let llmResult;
    try {
      llmResult = await this.llm.call({
        system: SYSTEM_PROMPT,
        user: userPrompt,
        temperature: 0.1,
        maxTokens: 200,
        timeoutMs: 8000,
      });
    } catch {
      return null;
    }

    const parsed = GeminiRiskManagerService.parseVerdict(llmResult.content);
    if (!parsed) return null;

    let autoClosed = false;
    const shouldAutoClose = parsed.verdict === 'broken' && parsed.confidence >= this.autoCloseMinConfidence;

    if (parsed.verdict === 'broken' && parsed.confidence >= 0.7) {
      // Persistance dans le decision_log dans tous les cas (shadow + auto)
      const mode = shouldAutoClose ? 'auto_v2' : 'shadow_v1';
      await this.persistAssessment({
        positionId: pos.id,
        symbol: pos.symbol,
        verdict: parsed.verdict,
        confidence: parsed.confidence,
        reason: parsed.reason,
        newsCount: news.length,
        llmCostUsd: llmResult.costUsd,
        autoClosed: false, // sera mis à jour après close effectif
      }, mode);

      if (shouldAutoClose) {
        this.logger.warn(
          `[risk-manager-v2] ${pos.symbol} THESIS_BROKEN conf=${parsed.confidence.toFixed(2)} → AUTO-CLOSE — ${parsed.reason}`,
        );
        autoClosed = await this.mechanical.closeForRiskManager(
          pos.id,
          pos.symbol,
          `thèse cassée conf=${parsed.confidence.toFixed(2)} — ${parsed.reason}`,
        );
        if (autoClosed) {
          // Enrichit le log avec autoClosed=true
          await this.persistAssessment({
            positionId: pos.id,
            symbol: pos.symbol,
            verdict: parsed.verdict,
            confidence: parsed.confidence,
            reason: parsed.reason,
            newsCount: news.length,
            llmCostUsd: 0, // déjà loggé
            autoClosed: true,
          }, 'auto_v2_closed');
        }
      } else {
        this.logger.warn(
          `[risk-manager] ${pos.symbol} THESIS_BROKEN conf=${parsed.confidence.toFixed(2)} (shadow, seuil auto=${this.autoCloseMinConfidence}) — ${parsed.reason}`,
        );
      }
    }

    return {
      positionId: pos.id,
      symbol: pos.symbol,
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      reason: parsed.reason,
      newsCount: news.length,
      llmCostUsd: llmResult.costUsd,
      autoClosed,
    };
  }

  static parseVerdict(content: string): { verdict: ThesisVerdict; confidence: number; reason: string } | null {
    const parsed = parseLlmJson<{ verdict?: string; confidence?: number; reason?: string }>(content);
    if (!parsed || typeof parsed !== 'object') return null;
    const v = parsed.verdict as ThesisVerdict;
    if (v !== 'valid' && v !== 'broken' && v !== 'unclear') return null;
    const c = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    const r = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '';
    return { verdict: v, confidence: c, reason: r };
  }

  private async persistAssessment(a: RiskAssessment, mode: string): Promise<void> {
    if (!this.supabase.isReady()) return;
    try {
      const { data: pos } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('portfolio_id')
        .eq('id', a.positionId)
        .single();
      const portfolioId = (pos as { portfolio_id?: string } | null)?.portfolio_id;
      if (!portfolioId) return;
      await this.supabase
        .getClient()
        .from('lisa_decision_log')
        .insert({
          portfolio_id: portfolioId,
          kind: 'risk_manager_thesis_broken',
          triggered_by: 'autopilot_cron',
          summary: `[RISK_MGR] ${a.symbol} thèse cassée conf=${a.confidence.toFixed(2)}${a.autoClosed ? ' → CLOSED' : ''}`,
          rationale: `${a.reason} (newsCount=${a.newsCount}, cost=$${a.llmCostUsd.toFixed(6)})`,
          payload: {
            position_id: a.positionId,
            symbol: a.symbol,
            verdict: a.verdict,
            confidence: a.confidence,
            reason: a.reason,
            news_count: a.newsCount,
            llm_cost_usd: a.llmCostUsd,
            mode,
            auto_closed: a.autoClosed,
          },
        });
    } catch (e) {
      this.logger.warn(`[risk-manager] persist failed: ${String(e).slice(0, 200)}`);
    }
  }
}
