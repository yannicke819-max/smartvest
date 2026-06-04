/**
 * Gemini Opportunity Scout — entry-side LLM news catalyst detector.
 *
 * Symétrique inverse de `GeminiRiskManagerService` :
 *   - V2 RiskManager : news négative → close position (exit)
 *   - Opportunity Scout : news positive → open position (entry)
 *
 * Architecture :
 *   - Cron toutes les 5 min : fetch news macro positives (sentiment > +0.4
 *     OU keywords haussiers : deal, breakthrough, surge, rally, easing,
 *     peace, reopening, beat, agreement, ceasefire, cut, dovish...)
 *   - Appel Gemini Flash Lite : "Quel SECTOR / asset_class bénéficie ?"
 *     Output : { sector, confidence, magnitude_expected_pct }
 *   - Mapping sector → ETF proxies tradables (table fermée hardcoded)
 *   - Pour chaque proxy avec confidence >= seuil + checks garde-fous → open
 *     position via LisaService.openForOpportunityScout (sizing réduit)
 *
 * Garde-fous (anti-trigger-happy, en PROD pas shadow) :
 *   - Sizing réduit (×0.3 du notional standard)
 *   - TP serré (3%), SL serré (1.5%)
 *   - Cap N opens par jour par portfolio
 *   - Cooldown 30 min par proxy (anti-doublon)
 *   - Anti-stale price (rejette si source stale ou fallback)
 *   - Vérif marché ouvert (session par-bourse)
 *   - Confidence min 0.80
 *
 * Coût : 1 fetch news/5min (cache 5min RiskManager mutualisable) + 1 Gemini
 * call/news positive identifiée. Cap ~5 calls/cycle = $0.0005/cycle.
 *
 * Gating : GEMINI_OPPORTUNITY_SCOUT_ENABLED (default false).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../../supabase/supabase.service';
import { ScannerLlmRouterService } from '../scanner-llm-router.service';
import { type EodhdNewsItem } from '../eodhd-enrichment.service';
import { NewsAggregatorService } from '../news-aggregator.service';
import { LisaService } from '../lisa.service';
import { parseLlmJson } from '../llm-json-parser.helper';

/**
 * Mapping sector → ETF/proxy tradables. Liste fermée — Gemini ne peut
 * que choisir parmi ces sectors, jamais inventer un ticker.
 */
const SECTOR_PROXIES: Record<string, { proxies: string[]; assetClass: string; venue: string }> = {
  japan_equity:        { proxies: ['EWJ.US', 'DXJ.US'],           assetClass: 'us_equity_large', venue: 'EODHD' },
  china_equity:        { proxies: ['FXI.US', 'KWEB.US'],          assetClass: 'us_equity_large', venue: 'EODHD' },
  europe_equity:       { proxies: ['VGK.US', 'EZU.US'],           assetClass: 'us_equity_large', venue: 'EODHD' },
  emerging_markets:    { proxies: ['EEM.US', 'VWO.US'],           assetClass: 'us_equity_large', venue: 'EODHD' },
  us_tech:             { proxies: ['QQQ.US', 'XLK.US'],           assetClass: 'us_equity_large', venue: 'EODHD' },
  us_finance:          { proxies: ['XLF.US', 'KBE.US'],           assetClass: 'us_equity_large', venue: 'EODHD' },
  us_healthcare:       { proxies: ['XLV.US'],                     assetClass: 'us_equity_large', venue: 'EODHD' },
  us_industrial:       { proxies: ['XLI.US'],                     assetClass: 'us_equity_large', venue: 'EODHD' },
  defense:             { proxies: ['ITA.US', 'XAR.US'],           assetClass: 'us_equity_large', venue: 'EODHD' },
  energy_oil_up:       { proxies: ['XLE.US', 'USO.US'],           assetClass: 'us_equity_large', venue: 'EODHD' },
  energy_oil_down:     { proxies: ['SCO.US'],                     assetClass: 'us_equity_large', venue: 'EODHD' },
  gold:                { proxies: ['GLD.US', 'IAU.US'],           assetClass: 'us_equity_large', venue: 'EODHD' },
  silver:              { proxies: ['SLV.US'],                     assetClass: 'us_equity_large', venue: 'EODHD' },
  crypto_btc:          { proxies: ['BTCUSDT'],                    assetClass: 'crypto_major',    venue: 'BINANCE' },
  crypto_eth:          { proxies: ['ETHUSDT'],                    assetClass: 'crypto_major',    venue: 'BINANCE' },
  semiconductors:      { proxies: ['SOXX.US', 'SMH.US'],          assetClass: 'us_equity_large', venue: 'EODHD' },
};

const POSITIVE_KEYWORDS = /\b(deal|agreement|breakthrough|beat|surge|rally|easing|peace|reopening|ceasefire|cut|dovish|stimulus|approve|merger|acquisition|upgrade|outperform|record|all.?time.?high)\b/i;

const SYSTEM_PROMPT = `You are a macro opportunity scout for an automated trading system.
You read recent positive news and identify which SECTOR will benefit, choosing strictly from a closed list.

Closed sectors list:
japan_equity, china_equity, europe_equity, emerging_markets,
us_tech, us_finance, us_healthcare, us_industrial,
defense, energy_oil_up, energy_oil_down,
gold, silver, crypto_btc, crypto_eth, semiconductors

Output STRICT JSON only:
{
  "sector": "<one of the closed list, or null if no clear match>",
  "confidence": 0.0-1.0,
  "magnitude_expected_pct": <number 0-10>,
  "reason": "short sentence max 80 chars"
}

Rules:
- Pick "energy_oil_up" if news is bullish for oil (war, supply cut, OPEC restriction)
- Pick "energy_oil_down" if news is bullish for oil-down (peace, supply boost, deal)
- Pick the most direct beneficiary, not a chain of 2nd order effects
- Confidence < 0.7 should default to sector=null
- Be conservative on confidence (false positives = losing trades)`;

interface ScoutVerdict {
  sector: string | null;
  confidence: number;
  magnitudeExpectedPct: number;
  reason: string;
}

@Injectable()
export class GeminiOpportunityScoutService {
  private readonly logger = new Logger(GeminiOpportunityScoutService.name);
  private readonly enabled: boolean;
  private readonly minConfidence: number;
  private readonly sizingRatio: number;
  private readonly maxOpensPerDay: number;
  private readonly cooldownMs: number;
  private readonly tpPct: number;
  private readonly slPct: number;

  /** Mémoire ouverture par proxy (anti-cooldown) — key=symbol, value=lastOpenMs */
  private lastOpenByProxy = new Map<string, number>();
  /** Compteur opens du jour (key=YYYY-MM-DD, value=count) */
  private dailyOpensCount = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llm: ScannerLlmRouterService,
    private readonly newsAggregator: NewsAggregatorService,
    private readonly lisa: LisaService,
  ) {
    this.enabled = (this.config.get<string>('GEMINI_OPPORTUNITY_SCOUT_ENABLED') ?? 'false').toLowerCase() === 'true';
    this.minConfidence = parseFloat(this.config.get<string>('GEMINI_OPPORTUNITY_SCOUT_MIN_CONFIDENCE') ?? '0.80');
    this.sizingRatio = parseFloat(this.config.get<string>('GEMINI_OPPORTUNITY_SCOUT_SIZING_RATIO') ?? '0.3');
    this.maxOpensPerDay = parseInt(this.config.get<string>('GEMINI_OPPORTUNITY_SCOUT_MAX_OPENS_PER_DAY') ?? '5', 10);
    const cooldownMin = parseInt(this.config.get<string>('GEMINI_OPPORTUNITY_SCOUT_COOLDOWN_MIN') ?? '30', 10);
    this.cooldownMs = cooldownMin * 60_000;
    this.tpPct = parseFloat(this.config.get<string>('GEMINI_OPPORTUNITY_SCOUT_TP_PCT') ?? '0.03');
    this.slPct = parseFloat(this.config.get<string>('GEMINI_OPPORTUNITY_SCOUT_SL_PCT') ?? '0.015');
    if (this.enabled) {
      this.logger.log(
        `[opportunity-scout] PROD ENABLED — minConf=${this.minConfidence} sizing×${this.sizingRatio} ` +
        `maxOpens/d=${this.maxOpensPerDay} cooldown=${cooldownMin}min TP=${(this.tpPct*100).toFixed(1)}% SL=${(this.slPct*100).toFixed(1)}%`,
      );
    }
  }

  /**
   * KILLED 04/06/2026 (décision user "un seul pipeline, pas d'extrapolation inutile") :
   * le @Cron est retiré, ce cron n'est plus jamais enregistré au boot. Le service reste
   * injecté pour ne pas casser le module, mais ne fait plus aucune action.
   *
   * Note : le helper LisaService.openForOpportunityScout(...) reste utilisé par
   * LiveTraderAgent (le tag DB venue_fee_detail.source='opportunity_scout' est un
   * misnomer hérité — c'est TRADER Mistral qui ouvre, pas Gemini). Ne pas confondre
   * cette boucle Gemini news → ETF proxies (KILLED) avec le helper d'ouverture
   * réutilisé par TRADER (toujours vivant).
   */
  async cronScout(): Promise<void> {
    // No-op permanent. Dead code retiré 04/06/2026 pour débloquer le CI TS
    // (verdict possibly null sur narrowing inutile post-`return`). Si réactivation
    // un jour, restaurer depuis l'historique (commit b1991761 ou avant 22879b9).
    return;
  }

  private async scoutNews(news: EodhdNewsItem): Promise<ScoutVerdict | null> {
    const userPrompt =
      `Recent news:\n` +
      `- Title: ${news.title}\n` +
      `- Sentiment: ${news.sentiment ?? 'n/a'}\n` +
      `- Preview: ${news.contentPreview?.slice(0, 300) ?? '(none)'}\n\n` +
      `Which SECTOR from the closed list will benefit? Output strict JSON only.`;

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

    const parsed = parseLlmJson<{ sector?: string | null; confidence?: number; magnitude_expected_pct?: number; reason?: string }>(llmResult.content);
    if (!parsed || typeof parsed !== 'object') return null;
    const sector = typeof parsed.sector === 'string' ? parsed.sector : null;
    const c = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    const m = typeof parsed.magnitude_expected_pct === 'number' ? Math.max(0, Math.min(10, parsed.magnitude_expected_pct)) : 0;
    const r = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '';
    return { sector, confidence: c, magnitudeExpectedPct: m, reason: r };
  }

  private async tryOpenOpportunity(
    proxy: string,
    assetClass: string,
    venue: string,
    verdict: ScoutVerdict,
    news: EodhdNewsItem,
  ): Promise<void> {
    // 1. Cooldown
    const lastOpenMs = this.lastOpenByProxy.get(proxy);
    if (lastOpenMs && Date.now() - lastOpenMs < this.cooldownMs) {
      return;
    }

    // 2. Cap opens / jour
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = this.dailyOpensCount.get(today) ?? 0;
    if (todayCount >= this.maxOpensPerDay) {
      this.logger.log(`[opportunity-scout] ${proxy} skip — cap quotidien atteint (${todayCount}/${this.maxOpensPerDay})`);
      return;
    }

    // 3. Prix live anti-stale
    const quote = await this.lisa.getLivePrice(proxy).catch(() => null);
    if (!quote || quote.source.startsWith('stale_') || quote.source.startsWith('fallback')) {
      this.logger.warn(`[opportunity-scout] ${proxy} skip — prix non fiable (source=${quote?.source ?? 'null'})`);
      return;
    }

    const livePrice = parseFloat(quote.price);
    if (!Number.isFinite(livePrice) || livePrice <= 0) {
      return;
    }

    // 4. Pull portfolios avec autopilot ON
    const { data: portfolios } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('portfolio_id, capital_usd, max_open_positions')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);

    if (!portfolios || portfolios.length === 0) return;

    // 5. Pour chaque portfolio → check position déjà ouverte sur proxy + open
    for (const cfg of portfolios as Array<{ portfolio_id: string; capital_usd: number | null; max_open_positions: number | null }>) {
      const portfolioId = cfg.portfolio_id;
      const capitalUsd = Number(cfg.capital_usd ?? 0);
      const maxOpenPositions = Number(cfg.max_open_positions ?? 3);
      if (capitalUsd < 200) continue; // sizing min sanity

      // Skip si déjà position ouverte sur proxy
      const { data: existing } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('id')
        .eq('portfolio_id', portfolioId)
        .eq('symbol', proxy)
        .eq('status', 'open')
        .limit(1);
      if (existing && existing.length > 0) continue;

      // Sizing réduit
      const standardNotional = capitalUsd * 0.10; // 10% standard
      const notionalUsd = standardNotional * this.sizingRatio;
      if (notionalUsd < 50) continue; // floor

      const stopLossPrice = (livePrice * (1 - this.slPct)).toFixed(6);
      const takeProfitPrice = (livePrice * (1 + this.tpPct)).toFixed(6);

      const position = await this.lisa.openForOpportunityScout({
        portfolioId,
        symbol: proxy,
        assetClass,
        venue,
        notionalUsd,
        livePrice,
        stopLossPrice,
        takeProfitPrice,
        horizonDays: 1,
        maxOpenPositions,
        rationale: `${verdict.sector} conf=${verdict.confidence.toFixed(2)} — ${verdict.reason}`,
      });

      if (!position) {
        this.logger.warn(`[opportunity-scout] openForOpportunityScout ${proxy} portfolio=${portfolioId} → null`);
        continue;
      }

      this.lastOpenByProxy.set(proxy, Date.now());
      this.dailyOpensCount.set(today, todayCount + 1);
      this.logger.log(
        `[opportunity-scout] ✅ OPEN ${proxy} @ ${livePrice.toFixed(4)} notional=$${notionalUsd.toFixed(0)} ` +
        `TP=${takeProfitPrice} SL=${stopLossPrice} sector=${verdict.sector} conf=${verdict.confidence.toFixed(2)}`,
      );

      // Audit
      await this.supabase
        .getClient()
        .from('lisa_decision_log')
        .insert({
          portfolio_id: portfolioId,
          kind: 'opportunity_scout_opened',
          triggered_by: 'autopilot_cron',
          summary: `[SCOUT] OPEN ${proxy} sur news positive ${verdict.sector} conf=${verdict.confidence.toFixed(2)}`,
          rationale: `${news.title.slice(0, 150)} → ${verdict.reason} (magnitude exp ${verdict.magnitudeExpectedPct.toFixed(1)}%)`,
          payload: {
            proxy,
            sector: verdict.sector,
            confidence: verdict.confidence,
            magnitude_expected_pct: verdict.magnitudeExpectedPct,
            news_title: news.title,
            news_sentiment: news.sentiment,
            live_price: livePrice,
            notional_usd: notionalUsd,
            stop_loss: stopLossPrice,
            take_profit: takeProfitPrice,
            position_id: position.id,
            mode: 'auto_prod',
          },
        });
    }
  }
}
