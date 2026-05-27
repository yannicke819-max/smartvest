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

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../../supabase/supabase.service';
import { ScannerLlmRouterService } from '../scanner-llm-router.service';
import { ScannerLessonsContextService } from '../scanner-lessons-context.service';
import { EodhdNewsService } from '../eodhd-news.service';
import { type EodhdNewsItem } from '../eodhd-enrichment.service';
import { NewsAggregatorService } from '../news-aggregator.service';
import { parseLlmJson } from '../llm-json-parser.helper';
import { MechanicalTradingService } from '../mechanical-trading.service';
import { LisaService } from '../lisa.service';

export type ThesisVerdict = 'valid' | 'broken' | 'unclear';

interface OpenPos {
  id: string;
  symbol: string;
  asset_class: string;
  entry_timestamp: string;
  entry_price: number;
  direction: string;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  peak_pre_exit: number | null;
}

interface PriceContext {
  current: number | null;
  source: string;
  pnlPct: number | null;
  distSlPct: number | null;
  distTpPct: number | null;
  peakPnlPct: number | null;
  retraceFromPeakPct: number | null;
}

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
You evaluate if the original thesis behind an OPEN position (LONG or SHORT — direction stated below) is still valid given:
1. Recent news/events (ticker-specific + macro)
2. Current price context (PnL, distance to stops, peak excursion)

DIRECTION CONVENTION (critical):
 - LONG  : thesis = "price goes UP". Positive news / sustained momentum = valid. Negative catalyst = broken.
 - SHORT : thesis = "price goes DOWN" (fade momentum / mean reversion). Negative news or fading momentum = valid (short works). Positive catalyst that pushes price UP = broken.
PnL is already signed for the direction: pnl > 0 always means "in profit", regardless of long/short.

Output STRICT JSON only:
{
  "verdict": "valid" | "broken" | "unclear",
  "confidence": 0.0-1.0,
  "reason": "short sentence max 80 chars"
}

Verdict rules:
- "broken" = clear negative catalyst (downgrade, profit warning, regulatory action, sector rout)
  AND it is actionable to exit NOW (not redundant with mechanical SL)
- "unclear" = mixed signals or no fresh news
- "valid" = positive or neutral context, no break in original thesis

Anti-friction rules (CRITICAL — avoid double-action with other services):
- If "position_age_min" < 15 → prefer "unclear" (EarlyExitGuard owns this window).
- If "distance_to_sl_pct" between 0 and 0.5% → prefer "unclear" (mechanical SL will fire imminently, your close is redundant).
- If "distance_to_tp_pct" between 0 and 0.5% → prefer "unclear" (mechanical TP will fire imminently).
- If "pnl_pct" > 1% AND "peak_pnl_pct" - "pnl_pct" < 0.5% → prefer "unclear" (trailing TP active, let it capture).
- "broken" with confidence>=0.8 should be reserved for cases where NEITHER mechanical SL NOR trailing will catch the move soon enough (e.g., big news shock at +2% gain — close NOW to lock).

Be conservative on "broken" (false positives = early exits = losses).
Confidence < 0.7 should default to "unclear".`;

const SYSTEM_PROMPT_GROUNDED = `${SYSTEM_PROMPT}

GOOGLE SEARCH GROUNDING ENABLED:
You have access to Google Search to fetch real-time news on the symbol and macro context.
USE IT especially for Asia/EU tickers (.KO, .KQ, .SHE, .SHG, .T, .HK, .PA, .DE, .LSE) where
our internal news provider (EODHD) has limited coverage.

When you have an open position to evaluate:
1. Search for "[SYMBOL] news today" OR "[COMPANY NAME] news last 4 hours" (find the company name from ticker)
2. Search for sector/macro impact ("Korean semiconductor news", "China stimulus news")
3. Cite the source URL in your reason field if a specific catalyst drives "broken" verdict

Rules:
- Limit to 2-3 search queries per assessment (latency budget)
- Prefer Reuters/Bloomberg/WSJ/Financial Times for credibility
- Recent news (< 4 hours) only — older news already priced in
- If grounded search returns nothing actionable → verdict "unclear" or "valid"`;

@Injectable()
export class GeminiRiskManagerService {
  private readonly logger = new Logger(GeminiRiskManagerService.name);
  private readonly enabled: boolean;
  private readonly autoCloseMinConfidence: number;
  private readonly useMacroNews: boolean;
  /** Google Search grounding — fetch news live en délégant à Gemini (couvre Asia/EU non-EODHD). */
  private readonly useGrounding: boolean;
  /** Cache 5 min des news macro globales — partagé pour toutes les positions du cycle. */
  private macroNewsCache: { data: EodhdNewsItem[]; asOf: number } | null = null;
  private readonly MACRO_NEWS_CACHE_MS = 5 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llm: ScannerLlmRouterService,
    private readonly eodhdNews: EodhdNewsService,
    private readonly newsAggregator: NewsAggregatorService,
    private readonly mechanical: MechanicalTradingService,
    private readonly lisa: LisaService,
    // Phase 3 — inject scanner_lessons dans system prompt (Optional pour back-compat tests).
    @Optional() private readonly lessonsContext?: ScannerLessonsContextService,
  ) {
    this.enabled = (this.config.get<string>('GEMINI_RISK_MANAGER_ENABLED') ?? 'false').toLowerCase() === 'true';
    const rawConf = parseFloat(this.config.get<string>('GEMINI_RISK_MANAGER_AUTO_CLOSE_MIN_CONFIDENCE') ?? '0.8');
    this.autoCloseMinConfidence = Number.isFinite(rawConf) && rawConf >= 0 && rawConf <= 1.1 ? rawConf : 0.8;
    this.useMacroNews = (this.config.get<string>('GEMINI_RISK_MANAGER_USE_MACRO_NEWS') ?? 'false').toLowerCase() === 'true';
    this.useGrounding = (this.config.get<string>('GEMINI_RISK_MANAGER_USE_GROUNDING') ?? 'false').toLowerCase() === 'true';
    if (this.enabled) {
      this.logger.log(
        `[risk-manager] V2 ENABLED — auto-close conf>=${this.autoCloseMinConfidence} — macro=${this.useMacroNews} — grounding=${this.useGrounding} — cron */5min`,
      );
    }
  }

  /**
   * Pull les news macro globales (sans symbol) avec cache 5 min.
   * Filtre : sentiment négatif OU mots-clés geopolitical/macro (Fed, CPI, Iran,
   * Hormuz, oil, etc.) car ce sont les seules pertinentes pour casser une thèse.
   */
  private async getMacroNews(heldSymbols: string[] = []): Promise<EodhdNewsItem[]> {
    if (!this.useMacroNews) return [];
    if (this.macroNewsCache && Date.now() - this.macroNewsCache.asOf < this.MACRO_NEWS_CACHE_MS) {
      return this.macroNewsCache.data;
    }
    try {
      // Multi-source : EODHD news global + StockTwits trending + Reddit hot + Twitter symbols
      // Cap retail social 30% appliqué côté aggregator (Reuters/Bloomberg priorisés).
      const aggr = await this.newsAggregator.aggregate(heldSymbols, 30);
      const MACRO_KEYWORDS = /\b(fed|fomc|cpi|nfp|gdp|ecb|boe|boj|inflation|recession|tariff|iran|hormuz|opec|oil|brent|wti|gold|war|sanctions|geopolitic|china|trade war|yields?|treasur|hike|rate cut|powell|lagarde|stimulus|tightening|easing)\b/i;
      const filtered = aggr.items.filter((n) => {
        const isNegative = typeof n.sentiment === 'number' && n.sentiment < -0.2;
        const isMacro = MACRO_KEYWORDS.test(`${n.title} ${n.contentPreview ?? ''}`);
        return isNegative || isMacro;
      }).slice(0, 10);
      this.macroNewsCache = { data: filtered, asOf: Date.now() };
      this.logger.debug(
        `[risk-manager] macro news : ${aggr.items.length} brut → ${filtered.length} retenu (sources : ${aggr.sources.map(s => `${s.provider}=${s.count}`).join(', ')})`,
      );
      return filtered;
    } catch (e) {
      this.logger.warn(`[risk-manager] macro news fetch failed: ${String(e).slice(0, 200)}`);
      return [];
    }
  }

  /**
   * Cron toutes les minutes (P19-EXT 25/05) — eval thèse pour chaque position open.
   *
   * Passage 5min → 60s : réactivité news/prix sur positions ouvertes. Coût LLM
   * marginal négligeable ($0.40 → $2/jour max). Bénéfice : détection thèse
   * cassée jusqu'à 4 min plus tôt sur news chocs (Iran/Hormuz/Fed/profit
   * warning). Garde-fou : cooldown re-entry 60min empêche le sur-trading même
   * si Gemini oscille verdict.
   *
   * Parallélisation Promise.all pour latence cycle ≤ 5s (vs ~20s séquentiel).
   *
   * Évaluation positions cappée à 20 (cf. fetchOpenPositions limit). Si plus
   * de 20 positions ouvertes simultanément, augmenter le cap.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async cronEvalOpenPositions(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    try {
      const positions = await this.fetchOpenPositions();
      if (positions.length === 0) return;
      // Pré-fetch news macro 1× pour tout le cycle (cache 5 min, partagé).
      // Le cache 5min absorbe les cycles minute pour éviter de spammer
      // EODHD/StockTwits/Reddit/Twitter — 1 fetch news / 5 min suffit.
      const heldSymbols = positions.map(p => p.symbol);
      if (this.useMacroNews) await this.getMacroNews(heldSymbols);
      this.logger.log(`[risk-manager] eval ${positions.length} open positions (parallel)`);
      // Parallélisation : tous les calls Gemini Flash-Lite en concurrent
      // (~700-1500ms each → cycle ≤ 5s au lieu de ~20s séquentiel).
      // Errors per-position isolées, n'arrêtent pas le batch.
      await Promise.all(
        positions.map((pos) =>
          this.assessThesis(pos).catch((e) => {
            this.logger.warn(`[risk-manager] ${pos.symbol} assessment failed: ${String(e).slice(0, 200)}`);
            return null;
          }),
        ),
      );
    } catch (e) {
      this.logger.warn(`[risk-manager] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async fetchOpenPositions(): Promise<Array<OpenPos>> {
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('id, symbol, asset_class, entry_timestamp, entry_price, direction, stop_loss_price, take_profit_price, peak_pre_exit')
      .eq('status', 'open')
      .limit(20);
    if (error || !data) return [];
    return data as Array<OpenPos>;
  }

  /** Calcule pnl/distances/peak depuis le live price + position. Pure-ish. */
  private async computePriceContext(pos: OpenPos): Promise<PriceContext> {
    const quote = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
    if (!quote || !quote.source || quote.source.startsWith('stale_') || quote.source.startsWith('fallback')) {
      return { current: null, source: quote?.source ?? 'unavailable', pnlPct: null, distSlPct: null, distTpPct: null, peakPnlPct: null, retraceFromPeakPct: null };
    }
    const current = parseFloat(quote.price);
    if (!Number.isFinite(current) || current <= 0 || pos.entry_price <= 0) {
      return { current: null, source: quote.source, pnlPct: null, distSlPct: null, distTpPct: null, peakPnlPct: null, retraceFromPeakPct: null };
    }
    const isLong = pos.direction.startsWith('long');
    const sign = isLong ? 1 : -1;
    const pnlPct = ((current - pos.entry_price) / pos.entry_price) * 100 * sign;
    const distSlPct = pos.stop_loss_price && pos.stop_loss_price > 0
      ? ((isLong ? current - pos.stop_loss_price : pos.stop_loss_price - current) / current) * 100
      : null;
    const distTpPct = pos.take_profit_price && pos.take_profit_price > 0
      ? ((isLong ? pos.take_profit_price - current : current - pos.take_profit_price) / current) * 100
      : null;
    const peakPnlPct = pos.peak_pre_exit && pos.peak_pre_exit > 0
      ? ((pos.peak_pre_exit - pos.entry_price) / pos.entry_price) * 100 * sign
      : null;
    const retraceFromPeakPct = peakPnlPct !== null && pnlPct !== null && peakPnlPct > 0
      ? peakPnlPct - pnlPct
      : null;
    return { current, source: quote.source, pnlPct, distSlPct, distTpPct, peakPnlPct, retraceFromPeakPct };
  }

  async assessThesis(pos: OpenPos): Promise<RiskAssessment | null> {
    const [news, macroNews, priceCtx] = await Promise.all([
      this.eodhdNews.getRecentNewsForTicker(pos.symbol, 1).catch(() => []),
      this.getMacroNews(),
      this.computePriceContext(pos),
    ]);

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

    // Anti-friction : si le contexte prix dit clairement "laisser faire les autres
    // services", on shortcut le call LLM (économie de coût + zéro risque action).
    if (priceCtx.pnlPct !== null) {
      const tooCloseToSl = priceCtx.distSlPct !== null && priceCtx.distSlPct >= 0 && priceCtx.distSlPct < 0.3;
      const tooCloseToTp = priceCtx.distTpPct !== null && priceCtx.distTpPct >= 0 && priceCtx.distTpPct < 0.3;
      if (ageMin < 15 || tooCloseToSl || tooCloseToTp) {
        // EarlyExitGuard owns 0-15min, Mechanical owns near-SL/TP — skip LLM
        return {
          positionId: pos.id, symbol: pos.symbol,
          verdict: 'unclear', confidence: 0,
          reason: ageMin < 15 ? 'in EarlyExitGuard window' : (tooCloseToSl ? 'mechanical SL imminent' : 'mechanical TP imminent'),
          newsCount: news.length, llmCostUsd: 0, autoClosed: false,
        };
      }
    }

    const priceBlock = priceCtx.current !== null
      ? `Price context (live, source=${priceCtx.source}):\n` +
        `- current_price: ${priceCtx.current.toFixed(4)}\n` +
        `- entry_price: ${pos.entry_price.toFixed(4)}\n` +
        `- pnl_pct: ${priceCtx.pnlPct?.toFixed(2) ?? 'n/a'}%\n` +
        `- distance_to_sl_pct: ${priceCtx.distSlPct?.toFixed(2) ?? 'n/a'}%\n` +
        `- distance_to_tp_pct: ${priceCtx.distTpPct?.toFixed(2) ?? 'n/a'}%\n` +
        `- peak_pnl_pct: ${priceCtx.peakPnlPct?.toFixed(2) ?? 'n/a'}%\n` +
        `- retrace_from_peak_pct: ${priceCtx.retraceFromPeakPct?.toFixed(2) ?? 'n/a'}%`
      : `⚠️ PRICE DATA UNAVAILABLE OR STALE (source=${priceCtx.source}).\n` +
        `→ Tu ne peux PAS évaluer la thèse sur le prix. Si tu vois une news\n` +
        `   négative claire sur le ticker/asset_class, verdict 'broken' conf 0.85+\n` +
        `   (la position est exposée sans visibilité, l'EarlyExit/Mechanical ne\n` +
        `   peuvent rien faire non plus sans prix live). Sinon, 'unclear'.`;

    // En mode grounded, Gemini fetch les news lui-même via Google Search.
    // L'EODHD tickerBlock reste injecté (gratuit, déjà fetched) mais l'utilisateur
    // est invité à chercher en plus pour les marchés mal couverts (Asia/EU).
    const groundingHint = this.useGrounding
      ? `\n\nGROUNDING: Use Google Search to fetch latest news for ${pos.symbol} (or company name) in the last 4h. Especially needed for asset_class=${pos.asset_class} where EODHD coverage is limited.\n`
      : '';

    const userPrompt =
      `Open ${pos.direction} position: ${pos.symbol} (${pos.asset_class}), age=${ageMin}min.\n\n` +
      `${priceBlock}\n\n` +
      `Ticker news EODHD (last 60min):\n${tickerBlock}\n\n` +
      `Macro / geopolitical news (last 60min, global feed):\n${macroBlock}\n\n` +
      groundingHint +
      `Apply the anti-friction rules from system prompt. Is the thesis broken AND ` +
      `actionable NOW (not redundant with mechanical SL/TP nor EarlyExitGuard)? Output strict JSON only.`;

    // Phase 3 — inject scanner_lessons context (post-mortem nightly insights).
    const lessonsBlock = this.lessonsContext
      ? await this.lessonsContext.getLessonsBlock('all_scanner', { assetClass: String(pos.asset_class ?? '') }).catch(() => '')
      : '';
    const baseSystem = this.useGrounding ? SYSTEM_PROMPT_GROUNDED : SYSTEM_PROMPT;
    const systemPrompt = lessonsBlock ? `${baseSystem}\n\n${lessonsBlock}` : baseSystem;

    let llmResult;
    try {
      llmResult = await this.llm.call({
        system: systemPrompt,
        user: userPrompt,
        temperature: 0.1,
        maxTokens: this.useGrounding ? 400 : 200, // grounded = + de tokens (cite sources)
        timeoutMs: this.useGrounding ? 15000 : 8000, // grounded = + de latence (search rounds)
        enableSearchGrounding: this.useGrounding,
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
