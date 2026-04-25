import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import Decimal from 'decimal.js';
import {
  CorpusQueryService,
  LisaClaudeClient,
  PaperBrokerService,
  RiskEnforcer,
  RiskMonitorService,
  ThesisGeneratorService,
  type AllocationProposal,
  type HistoryMetrics,
  type LisaSessionConfig,
  type MarketSnapshot,
  type PaperPosition,
  type PerformanceObjectives,
  type PortfolioSnapshot,
  type RecentStreak,
  type SessionProfile,
  type TrajectoryStatus,
} from '@smartvest/ai-analyst';
import { BinanceAdapter } from '@smartvest/brokers';
import { SupabaseService } from '../../supabase/supabase.service';
import { DecisionLogService } from './decision-log.service';
import { RealtimePriceService } from './realtime-price.service';
import { EodhdEnrichmentService } from './eodhd-enrichment.service';
import { EodhdCalendarService } from './eodhd-calendar.service';
import { NewsRankerService } from './news-ranker.service';
import { NewsAggregatorService } from './news-aggregator.service';
import { EodhdTechnicalService } from './eodhd-technical.service';
import { EodhdIntradayService } from './eodhd-intraday.service';
import { BinanceMarketService } from './binance-market.service';
import { EodhdMacroService } from './eodhd-macro.service';
import { EodhdScreenerService } from './eodhd-screener.service';
import { EodhdInsiderService } from './eodhd-insider.service';
import { EodhdOptionsService } from './eodhd-options.service';
import { BinanceLiquidationsService } from './binance-liquidations.service';

/**
 * LisaService — orchestrateur principal du module AI analyst.
 *
 * Coordonne :
 *  - Config session (CRUD)
 *  - Génération de propositions via Claude
 *  - Enforcement des risk constraints
 *  - Ouverture/fermeture positions simulées
 *  - Snapshots + risk monitoring
 */
@Injectable()
export class LisaService {
  private readonly logger = new Logger(LisaService.name);
  private readonly claudeClient: LisaClaudeClient | null;
  private readonly corpusQuery: CorpusQueryService;
  private readonly thesisGenerator: ThesisGeneratorService | null;
  private readonly riskEnforcer: RiskEnforcer;
  private readonly paperBroker: PaperBrokerService;
  private readonly riskMonitor: RiskMonitorService;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly decisionLog: DecisionLogService,
    private readonly realtimePrice: RealtimePriceService,
    private readonly eodhdEnrichment: EodhdEnrichmentService,
    private readonly eodhdTechnical: EodhdTechnicalService,
    private readonly eodhdIntraday: EodhdIntradayService,
    private readonly binanceMarket: BinanceMarketService,
    private readonly eodhdMacro: EodhdMacroService,
    private readonly eodhdScreener: EodhdScreenerService,
    private readonly eodhdInsider: EodhdInsiderService,
    private readonly eodhdOptions: EodhdOptionsService,
    private readonly binanceLiquidations: BinanceLiquidationsService,
    private readonly eodhdCalendar: EodhdCalendarService,
    private readonly newsRanker: NewsRankerService,
    private readonly newsAggregator: NewsAggregatorService,
  ) {
    const anthropicKey = this.config.get<string>('ANTHROPIC_API_KEY');
    this.claudeClient = anthropicKey
      ? new LisaClaudeClient(anthropicKey, 'claude-opus-4-7')
      : null;

    if (!this.claudeClient) {
      this.logger.warn('ANTHROPIC_API_KEY absent — thesis generation disabled');
    }

    this.corpusQuery = new CorpusQueryService(this.supabase.getClient());
    this.riskEnforcer = new RiskEnforcer();

    this.paperBroker = new PaperBrokerService({
      supabase: this.supabase.getClient(),
      fetchLivePrice: async (symbol) => this.fetchLivePrice(symbol),
    });

    this.thesisGenerator = this.claudeClient
      ? new ThesisGeneratorService(this.claudeClient, this.corpusQuery)
      : null;

    this.riskMonitor = new RiskMonitorService(
      this.supabase.getClient(),
      this.paperBroker,
      async (symbol) => {
        const q = await this.fetchLivePrice(symbol);
        return { price: q.price };
      },
    );
  }

  // ── Session config ──────────────────────────────────────────────────────────

  async getSessionConfig(userId: string, portfolioId: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async upsertSessionConfig(userId: string, portfolioId: string, config: Record<string, unknown>) {
    // Vérifier que le portefeuille appartient bien à l'user ET is_simulation
    const { data: portfolio, error: pErr } = await this.supabase.getClient()
      .from('portfolios')
      .select('id, user_id, is_simulation')
      .eq('id', portfolioId)
      .eq('user_id', userId)
      .maybeSingle();
    if (pErr || !portfolio) throw new NotFoundException('Portfolio introuvable');
    if (!portfolio.is_simulation) {
      throw new BadRequestException('Lisa ne peut opérer QUE sur un portefeuille de simulation (is_simulation=true)');
    }

    // Accept both snake_case (frontend native) and camelCase (domain type).
    // Le frontend envoie par convention du snake_case qui matche les colonnes DB.
    // IMPORTANT : on distingue "clé absente du payload" (= pas de changement)
    // vs "clé présente avec valeur null" (= clear explicite). Le ?? de
    // l'ancienne version confondait les deux cas, ce qui empêchait de
    // nettoyer autopilot_expires_at quand le user décochait auto_approve.
    const hasKey = (obj: Record<string, unknown>, key: string): boolean =>
      Object.prototype.hasOwnProperty.call(obj, key);
    const pick = <T>(snake: string, camel: string, fallback: T): T => {
      if (hasKey(config, snake)) return config[snake] as T;
      if (hasKey(config, camel)) return config[camel] as T;
      return fallback;
    };

    // Fetch existing row to preserve fields not sent in the partial update
    const { data: existing } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    const merged = {
      user_id: userId,
      portfolio_id: portfolioId,
      profile: pick('profile', 'profile', existing?.profile ?? 'long_term_investor'),
      capital_usd: pick('capital_usd', 'capitalUsd', existing?.capital_usd ?? '10000'),
      base_currency: pick('base_currency', 'baseCurrency', existing?.base_currency ?? 'EUR'),
      risk_constraints: pick('risk_constraints', 'riskConstraints', existing?.risk_constraints ?? {}),
      include_asset_classes: pick('include_asset_classes', 'includeAssetClasses', existing?.include_asset_classes ?? null),
      exclude_asset_classes: pick('exclude_asset_classes', 'excludeAssetClasses', existing?.exclude_asset_classes ?? null),
      anti_consensus_strength: pick('anti_consensus_strength', 'antiConsensusStrength', existing?.anti_consensus_strength ?? 7),
      max_theses: pick('max_theses', 'maxTheses', existing?.max_theses ?? 5),
      enable_crypto: pick('enable_crypto', 'enableCrypto', existing?.enable_crypto ?? true),
      enable_derivatives: pick('enable_derivatives', 'enableDerivatives', existing?.enable_derivatives ?? false),
      enable_leverage: pick('enable_leverage', 'enableLeverage', existing?.enable_leverage ?? false),
      autopilot_enabled: pick('autopilot_enabled', 'autopilotEnabled', existing?.autopilot_enabled ?? false),
      autopilot_cycle_minutes: pick('autopilot_cycle_minutes', 'autopilotCycleMinutes', existing?.autopilot_cycle_minutes ?? 15),
      autopilot_auto_approve: pick('autopilot_auto_approve', 'autopilotAutoApprove', existing?.autopilot_auto_approve ?? false),
      autopilot_expires_at: pick('autopilot_expires_at', 'autopilotExpiresAt', existing?.autopilot_expires_at ?? null),
      autopilot_aggressive: pick('autopilot_aggressive', 'autopilotAggressive', existing?.autopilot_aggressive ?? false),
      autopilot_market_hours_only: pick('autopilot_market_hours_only', 'autopilotMarketHoursOnly', existing?.autopilot_market_hours_only ?? false),
      // Lisa v2 — objectifs & budget (tous nullables)
      return_target_daily_pct: pick('return_target_daily_pct', 'returnTargetDailyPct', existing?.return_target_daily_pct ?? null),
      return_target_monthly_pct: pick('return_target_monthly_pct', 'returnTargetMonthlyPct', existing?.return_target_monthly_pct ?? null),
      return_target_annual_pct: pick('return_target_annual_pct', 'returnTargetAnnualPct', existing?.return_target_annual_pct ?? null),
      daily_cost_budget_usd: pick('daily_cost_budget_usd', 'dailyCostBudgetUsd', existing?.daily_cost_budget_usd ?? null),
      performance_horizon_days: pick('performance_horizon_days', 'performanceHorizonDays', existing?.performance_horizon_days ?? 30),
    };

    // Validation : auto_approve exige uniquement un portefeuille de simulation
    // (déjà vérifié plus haut). L'expiration est suggestive côté UI mais non
    // bloquante ici — l'utilisateur peut laisser tourner sans deadline s'il
    // le souhaite. Le kill-switch et le bouton de désactivation restent
    // toujours accessibles comme garde-fous opérationnels.
    if (merged.autopilot_auto_approve === true) {
      const expiresAt = merged.autopilot_expires_at as string | null;
      if (expiresAt) {
        const expiresMs = new Date(expiresAt).getTime();
        if (isNaN(expiresMs)) {
          throw new BadRequestException('autopilot_expires_at : date invalide.');
        }
      }
    }

    let { data, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .upsert(merged, { onConflict: 'portfolio_id' })
      .select()
      .single();

    // Si la colonne autopilot_market_hours_only n'existe pas encore en DB
    // (migration 0047 pas encore appliquée), Supabase renvoie une erreur 400
    // "Could not find the '...' column". On retente sans ce champ pour que
    // la sauvegarde des autres champs ne soit pas bloquée.
    if (error && /return_target_|daily_cost_budget_usd|performance_horizon_days/i.test(error.message)) {
      this.logger.warn('Colonnes Lisa v2 (0050) absentes — retry sans objectifs');
      const {
        return_target_daily_pct: _a,
        return_target_monthly_pct: _b,
        return_target_annual_pct: _c,
        daily_cost_budget_usd: _d,
        performance_horizon_days: _e,
        ...mergedFallback
      } = merged;
      void _a; void _b; void _c; void _d; void _e;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error && /autopilot_market_hours_only/i.test(error.message)) {
      this.logger.warn('Colonne autopilot_market_hours_only absente — retry sans ce champ');
      const { autopilot_market_hours_only: _omit, ...mergedFallback } = merged;
      void _omit;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  // ── Proposal generation ────────────────────────────────────────────────────

  /**
   * P5.4 — Détecte si le userFocus vient d'un wake-up agent (AgentLisaSyncService).
   * En wake-up mode, on réduit max_theses pour que Lisa réponde vite et cible
   * ses tactical_overrides plutôt que régénérer 5 nouvelles thèses.
   */
  private isWakeUpMode(userFocus?: string): boolean {
    return !!userFocus && userFocus.startsWith('WAKE-UP');
  }

  async generateProposal(userId: string, portfolioId: string, userFocus?: string): Promise<AllocationProposal> {
    if (!this.thesisGenerator) {
      throw new BadRequestException('Thesis generator unavailable: ANTHROPIC_API_KEY not configured on backend');
    }

    const config = await this.getSessionConfig(userId, portfolioId);
    if (!config) throw new NotFoundException('Session config introuvable — configurer d\'abord');

    const sessionConfig: LisaSessionConfig = {
      profile: config.profile as SessionProfile,
      capitalUsd: String(config.capital_usd),
      baseCurrency: config.base_currency as string,
      riskConstraints: {
        maxDrawdown2DaysPct: 10,
        maxDrawdown7DaysPct: 15,
        maxDrawdown30DaysPct: 25,
        maxPositionSizePct: 25,
        maxOpenPositions: 10,
        maxLeverage: 1.5,
        maxExposurePerAssetClassPct: 40,
        maxPortfolioVolatilityPct: 20,
        targetDeploymentPct: 60,
        autoLiquidateOnKill: true,
        ...(config.risk_constraints as Partial<LisaSessionConfig['riskConstraints']> ?? {}),
      },
      antiConsensusStrength: (config.anti_consensus_strength as number) ?? 7,
      // P5.4 — Wake-up mode : l'agent a détecté un signal urgent. Lisa doit
      // répondre vite avec un focus sur les tactical_overrides plutôt que
      // régénérer 5 thèses complètes. On baisse max_theses à 2 pour réduire
      // les tokens output (~70% de coût en moins, ~50% de latence en moins).
      maxTheses: this.isWakeUpMode(userFocus)
        ? 2
        : ((config.max_theses as number) ?? 5),
      enableCrypto: (config.enable_crypto as boolean) ?? true,
      enableDerivatives: (config.enable_derivatives as boolean) ?? false,
      enableLeverage: (config.enable_leverage as boolean) ?? false,
    };

    const marketSnapshot = await this.fetchMarketSnapshot();

    // Enrichissement EODHD Premium : calendrier économique + macro +
    // screener (pas dépendants des positions). News fetchée plus bas une
    // fois les positions connues (NewsAggregator a besoin des heldSymbols
    // pour fetcher StockTwits/Twitter ciblés).
    try {
      const [econEvents, macro, screenerSummary] = await Promise.all([
        this.eodhdEnrichment.fetchUpcomingEconomicEvents(7, 1),
        this.eodhdMacro.getMacroContext('USA').catch(() => null),
        this.eodhdScreener.summarizeAllScans().catch(() => ''),
      ]);
      if (screenerSummary) {
        marketSnapshot.screenerCandidates = screenerSummary;
      }
      if (macro) {
        marketSnapshot.macroContext = {
          country: macro.country,
          realRateUsPct: macro.realRate?.value ?? null,
          inflationYoyPct: macro.inflationYoY?.value ?? null,
          unemploymentPct: macro.unemployment?.value ?? null,
          gdpYoyPct: macro.gdpGrowth?.value ?? null,
        };
      }
      // Trie les events : importance desc (3→1), puis date asc — les plus
      // critiques en premier. Cap à 20 pour éviter bloat du prompt.
      const sortedEvents = [...econEvents].sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        return new Date(a.date).getTime() - new Date(b.date).getTime();
      });
      marketSnapshot.upcomingEvents = sortedEvents.slice(0, 20).map((e) => ({
        name: `${e.country ? `[${e.country}] ` : ''}${e.name}${e.estimate ? ` (est ${e.estimate})` : ''}`,
        date: e.date,
        importance: e.importance === 3 ? 'high' : e.importance === 2 ? 'medium' : 'low',
      }));
    } catch (e) {
      this.logger.warn(`EODHD enrichment partial failure: ${String(e).slice(0, 120)}`);
    }

    // Persona "chasseur EV+" injectée en amont du user focus si le flag est actif.
    // N'ajoute AUCUN droit d'exécution réelle — elle modifie juste le cadrage de
    // l'analyse produite par Claude (plus de turnover, sizing plus agressif dans
    // les limites toujours imposées par le risk_enforcer).
    const aggressivePersona = (config.autopilot_aggressive === true)
      ? `\n# PERSONA OVERRIDE — CHASSEUSE SÉLECTIVE EV+ (simulation uniquement)
Tu opères en mode chasse agressive MAIS sélective. Philosophie centrale :
**LET WINNERS RUN, ne fais rien si rien ne mérite d'être fait.**

## Règles d'OUVERTURE (discrétion stricte)
- Tu n'ouvres une nouvelle thèse QUE si son risk/reward est meilleur que le
  PIRE R/R des positions existantes — sinon tu remplaces une bonne idée par
  une moins bonne, perte sèche.
- Si le portefeuille est globalement en gain et que toutes les thèses
  initiales tiennent → DEFAULT = HOLD. Retourne un array \`theses\` vide,
  c'est une réponse parfaitement valide et souvent la meilleure.
- Pas de honte à dire « rien à proposer ce cycle » dans \`warnings\`. Le
  meilleur trade est très souvent celui qu'on ne fait pas.
- Chaque trade coûte des fees + spread + slippage simulés (~10-30 bps) qui
  GRIGNOTENT les gains acquis. Le turnover pour le turnover détruit la perf.

## Règles de FERMETURE (toujours actives, pas de discrétion)
- Stop-loss déclenché → fermeture (gérée par le risk monitor, hors prompt).
- Thèse INVALIDÉE par un nouvel élément (news, macro, prix qui invalide le
  setup) → \`closeRecommendations\` immédiat avec rationale.
- Risque devenu asymétrique défavorable (R/R retombé < 1) → fermeture.
- Une position pourrie qui stagne sans catalyseur clair > son horizon → fermeture.

## RÈGLE CRITIQUE — arbitrage cash saturé
Si le bloc "RÉSUMÉ PORTEFEUILLE" montre un cash disponible < 10 % du
capital total ET que tu identifies une nouvelle thèse avec R/R strictement
supérieur à la pire position existante :
→ tu DOIS inclure cette pire position dans \`closeRecommendations\` pour
   libérer le cash nécessaire à la nouvelle ouverture.
→ Ne propose JAMAIS une nouvelle thèse avec allocation > cash disponible
   sans fermeture proportionnelle en \`closeRecommendations\`.
→ Ton sizing doit être réaliste : si après fermetures tu libères X $, la
   somme de tes allocations ne peut pas dépasser X + cash initial.
Principe : recycler le capital, pas accumuler au-dessus de 100 %.

## Stop-loss obligatoire à toute nouvelle ouverture
Champ \`invalidation.conditions\` doit contenir au moins une condition de prix
quantifiée (jamais juste qualitatif).

## Hard limits (priment sur tout)
Drawdown intraday > ${((config.risk_constraints as Record<string, unknown> | null)?.maxDrawdown2DaysPct ?? 10)}% : tu réduis l'exposition,
tu n'ouvres rien de neuf. Les contraintes "Risk constraints" sont absolues.

## En résumé
- Portefeuille en gain stable + thèses initiales OK → HOLD (\`theses\`: []).
- Position se dégrade → close ou rebalance.
- Opportunité VRAIMENT meilleure que l'existant → ouverture sélective.
- Jamais d'ouverture par habitude juste parce que le cycle se déclenche.
`
      : '';

    const mergedFocus = [aggressivePersona, userFocus].filter((s) => s && s.trim().length > 0).join('\n\n');

    // Récupère les positions ouvertes + cash pour gestion active
    const currentSnapshot = await this.paperBroker.computeSnapshot(portfolioId);
    const openPositionsRaw = await this.paperBroker.getPositions(portfolioId, true);

    // Pré-fetch enrichissement fondamentaux + earnings pour tous les symbols
    // ouverts (les fonctions gèrent le cache et les exclusions crypto/FX).
    const uniqueSymbols = Array.from(new Set(openPositionsRaw.map((p) => p.symbol)));
    const [earningsAll, fundamentalsArr] = await Promise.all([
      this.eodhdEnrichment.fetchEarningsForSymbols(uniqueSymbols, 14),
      Promise.all(uniqueSymbols.map((s) => this.eodhdEnrichment.fetchKeyFundamentals(s))),
    ]);
    const fundamentalsBySymbol = new Map<string, typeof fundamentalsArr[number]>();
    uniqueSymbols.forEach((s, i) => fundamentalsBySymbol.set(s, fundamentalsArr[i]));

    // News pipeline complet — agrégation multi-source (EODHD + StockTwits
    // + Reddit + Twitter), scoring 4 axes + convergence cross-source,
    // dédup, bucketing. Substitue le dump naïf des 10 dernières headlines
    // par un bloc analytique avec scoring détaillé par item.
    try {
      const aggregate = await this.newsAggregator.aggregate(uniqueSymbols, 30);
      if (aggregate.items.length > 0) {
        const halfLifeHours = sessionConfig.profile === 'hyper_active' ? 3
          : sessionConfig.profile === 'active_trading' || sessionConfig.profile === 'sniper_mode' ? 6
          : 12;
        const ranked = this.newsRanker.rank(aggregate.items, uniqueSymbols, halfLifeHours, 15);
        const buckets = this.newsRanker.bucket(ranked);
        const sourcesSummary = aggregate.sources
          .map((s) => `${s.provider}=${s.count}${s.ok ? '' : '✗'}`)
          .join(' ');
        marketSnapshot.newsAnalysis = `📡 Sources fetched: ${sourcesSummary} (${aggregate.elapsedMs}ms)\n\n${this.newsRanker.formatForBriefing(buckets)}`;
        // Override recentNews legacy avec uniquement les pertinentes/bruit
        // pour éviter que Claude raisonne sur des news écartées via le
        // fallback path (au cas où newsAnalysis ne serait pas exploité).
        const keep = [...buckets.relevant, ...buckets.noise].slice(0, 10);
        marketSnapshot.recentNews = keep.map((r) => ({
          headline: r.title,
          source: r.sourceDomain ?? (r.symbols.length > 0 ? r.symbols.slice(0, 3).join(', ') : 'general'),
          timestamp: r.date,
          relevance: r.scores.final >= 70 ? 'high' : r.scores.final >= 40 ? 'medium' : 'low',
          sentiment: r.sentiment,
        }));
      }
    } catch (e) {
      this.logger.warn(`news aggregator failure (non-blocking): ${String(e).slice(0, 200)}`);
    }

    const openPositions = await Promise.all(openPositionsRaw.map(async (pos) => {
      let currentPrice = pos.entryPrice;
      try {
        const q = await this.fetchLivePrice(pos.symbol);
        currentPrice = q.price;
      } catch { /* fallback entryPrice */ }
      const entryPx = new Decimal(pos.entryPrice);
      const livePx = new Decimal(currentPrice);
      const sign = pos.direction === 'long' || pos.direction === 'long_call' || pos.direction === 'long_put' ? 1 : -1;
      const unrealizedPnlPct = entryPx.isZero()
        ? 0
        : livePx.minus(entryPx).dividedBy(entryPx).mul(sign).mul(100).toNumber();
      const ageDays = Math.floor((Date.now() - new Date(pos.entryTimestamp).getTime()) / 86_400_000);
      const horizonDays = pos.horizonTargetDate
        ? Math.ceil((new Date(pos.horizonTargetDate).getTime() - new Date(pos.entryTimestamp).getTime()) / 86_400_000)
        : null;
      // Fundamentals + prochain earning pour ce symbole (si applicable)
      const fundamentals = fundamentalsBySymbol.get(pos.symbol) ?? null;
      const nextEarning = earningsAll
        .filter((e) => e.symbol.toUpperCase().includes(pos.symbol.toUpperCase().split('.')[0]))
        .sort((a, b) => new Date(a.reportDate).getTime() - new Date(b.reportDate).getTime())[0] ?? null;

      return {
        positionId: pos.id,
        symbol: pos.symbol,
        assetClass: pos.assetClass,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        currentPrice,
        quantity: pos.quantity,
        entryNotionalUsd: pos.entryNotionalUsd,
        unrealizedPnlPct,
        ageDays,
        horizonDays,
        fundamentals,
        nextEarning,
      };
    }));

    // Lisa v2 — portfolio trajectory optimizer : on lit les objectifs de
    // la config session et on calcule les métriques historiques avant de
    // lancer Claude, pour que le bloc # MISSION soit complet.
    const objectives: PerformanceObjectives = {
      returnTargetDailyPct: config.return_target_daily_pct !== null && config.return_target_daily_pct !== undefined
        ? Number(config.return_target_daily_pct) : null,
      returnTargetMonthlyPct: config.return_target_monthly_pct !== null && config.return_target_monthly_pct !== undefined
        ? Number(config.return_target_monthly_pct) : null,
      returnTargetAnnualPct: config.return_target_annual_pct !== null && config.return_target_annual_pct !== undefined
        ? Number(config.return_target_annual_pct) : null,
      dailyCostBudgetUsd: config.daily_cost_budget_usd !== null && config.daily_cost_budget_usd !== undefined
        ? Number(config.daily_cost_budget_usd) : null,
      performanceHorizonDays: Number(config.performance_horizon_days ?? 30),
    };

    const historyMetrics = await this.computeHistoryMetrics(portfolioId);
    const { status: trajectoryStatus, targetExtrapolatedPct: targetExtrapolated7dPct } =
      this.computeTrajectoryStatus(objectives, historyMetrics);

    // Fetch les indicateurs techniques + bougies intraday 5m pour chaque
    // position ouverte en parallèle — permet à Lisa de décider quand
    // clôturer (RSI overbought, ATR spike, MACD bearish cross) et à l'agent
    // de dimensionner les stops ATR-based, et donne une vue réelle du
    // price action (20 bougies 5m = 1h40 de contexte).
    const technicalBySymbol: Record<string, import('./eodhd-technical.service').TechnicalIndicators> = {};
    const intradayBySymbol: Record<string, string> = {}; // symbol → résumé texte
    const insiderLines: string[] = [];
    const optionsLines: string[] = [];
    const liquidationsLines: string[] = [];
    if (openPositions.length > 0) {
      await Promise.all(openPositions.flatMap((pos) => {
        const eodhdTicker = this.toEodhdTicker(pos.symbol);
        const currentPrice = Number(pos.currentPrice);
        const isCrypto = pos.assetClass?.toLowerCase().includes('crypto');
        const isEquity = pos.assetClass?.toLowerCase().includes('equit') || pos.assetClass?.toLowerCase().includes('stock');
        const tasks: Promise<unknown>[] = [
          this.eodhdTechnical.getIndicators(eodhdTicker, currentPrice)
            .then((ind) => { technicalBySymbol[pos.symbol] = ind; })
            .catch((e) => this.logger.debug(`tech indicators failed for ${pos.symbol}: ${String(e).slice(0, 80)}`)),
        ];
        if (isCrypto) {
          // Crypto → Binance direct (plus frais que EODHD + 24h stats gratuit)
          tasks.push(
            this.binanceMarket.summarize(pos.symbol)
              .then((s) => { if (s) intradayBySymbol[pos.symbol] = s; })
              .catch((e) => this.logger.debug(`binance summary failed for ${pos.symbol}: ${String(e).slice(0, 80)}`)),
            this.binanceLiquidations.getSnapshot(pos.symbol)
              .then((snap) => {
                const line = this.binanceLiquidations.summarize(snap);
                if (line) liquidationsLines.push(line);
              })
              .catch((e) => this.logger.debug(`liquidations failed for ${pos.symbol}: ${String(e).slice(0, 80)}`)),
          );
        } else {
          tasks.push(
            this.eodhdIntraday.getCandles(eodhdTicker, '5m', 20)
              .then((series) => {
                if (series) intradayBySymbol[pos.symbol] = this.eodhdIntraday.summarize(series);
              })
              .catch((e) => this.logger.debug(`intraday fetch failed for ${pos.symbol}: ${String(e).slice(0, 80)}`)),
          );
          if (isEquity) {
            tasks.push(
              this.eodhdInsider.getInsiderSignal(pos.symbol, 30)
                .then((sig) => {
                  const line = this.eodhdInsider.summarize(sig);
                  if (line) insiderLines.push(`${pos.symbol} ${line}`);
                })
                .catch((e) => this.logger.debug(`insider failed for ${pos.symbol}: ${String(e).slice(0, 80)}`)),
              this.eodhdOptions.getSnapshot(pos.symbol)
                .then((snap) => {
                  const line = this.eodhdOptions.summarize(snap);
                  if (line) optionsLines.push(line);
                })
                .catch((e) => this.logger.debug(`options failed for ${pos.symbol}: ${String(e).slice(0, 80)}`)),
            );
          }
        }
        return tasks;
      }));

      if (insiderLines.length > 0) marketSnapshot.insiderSignals = insiderLines.join('\n');
      if (optionsLines.length > 0) marketSnapshot.optionsSignals = optionsLines.join('\n');
      if (liquidationsLines.length > 0) marketSnapshot.liquidationsSignals = liquidationsLines.join('\n');
    }

    // Earnings calendar pour les positions equity ouvertes (skip les
    // crypto/FX/ETF via filtre interne du service). Évite que Lisa propose
    // une thèse equity dont l'horizon couvre un earnings imminent
    // (event binaire) — coût Claude payé pour rien si mechanical rejette.
    const earningsBySymbol: Record<string, string | null> = {};
    if (openPositions.length > 0) {
      await Promise.all(
        openPositions.map(async (pos) => {
          const next = await this.eodhdCalendar
            .getNextEarningsDate(pos.symbol, 30)
            .catch(() => null);
          if (next) earningsBySymbol[pos.symbol] = next;
        }),
      );
    }

    let result: Awaited<ReturnType<ThesisGeneratorService['generateTheses']>>;
    try {
      result = await this.thesisGenerator.generateTheses({
        config: sessionConfig,
        marketSnapshot,
        ...(mergedFocus ? { userFocus: mergedFocus } : {}),
        includeFullCorpus: true,
        openPositions,
        availableCashUsd: currentSnapshot.cashUsd,
        objectives,
        historyMetrics,
        trajectoryStatus,
        targetExtrapolated7dPct,
        technicalBySymbol,
        intradayBySymbol,
        earningsBySymbol,
      });
    } catch (e) {
      // Parse failure ou erreur Claude : on log dans le decision log et on
      // retourne une erreur 400 explicite avec contexte lisible (pas un 500
      // qui fait croire à une panne d'infra).
      const msg = e instanceof Error ? e.message : String(e);

      // Détection spéciale : crédit Anthropic épuisé. Messages typiques :
      //   "credit_balance_too_low"
      //   "invalid_request_error" + "credit"
      //   HTTP 400 avec type "invalid_request_error"
      const isCreditExhausted = /credit.*too.?low|insufficient.*credit|credit.*balance/i.test(msg)
        || /\b400\b.*invalid_request_error.*credit/i.test(msg);

      if (isCreditExhausted) {
        // Auto-pause TOUT l'autopilot (pas juste auto_approve) pour arrêter
        // d'essayer en boucle et empirer la facture.
        await this.supabase.getClient()
          .from('lisa_session_configs')
          .update({
            autopilot_enabled: false,
            autopilot_auto_approve: false,
            autopilot_aggressive: false,
            autopilot_expires_at: null,
          })
          .eq('portfolio_id', portfolioId);

        await this.logDecision(portfolioId, 'anthropic_credit_exhausted', {
          summary: '⚠️ Crédit Anthropic épuisé — autopilot désactivé automatiquement',
          rationale: `Erreur API reçue : ${msg.slice(0, 500)}. L'autopilot a été coupé pour éviter d'autres appels qui échoueraient. Recharger le crédit sur console.anthropic.com, puis réactiver manuellement l'autopilot.`,
          payload: { source: 'thesis_generator', errorType: 'credit_exhausted' },
          triggeredBy: 'user_manual',
        });

        throw new BadRequestException(
          `⚠️ CRÉDIT ANTHROPIC ÉPUISÉ — L'autopilot a été désactivé automatiquement pour éviter d'autres tentatives coûteuses. Recharge le crédit sur console.anthropic.com, puis réactive l'autopilot depuis la page Lisa.`,
        );
      }

      await this.logDecision(portfolioId, 'proposal_failed', {
        summary: 'Génération proposition échouée',
        rationale: msg.slice(0, 2000),
        payload: { source: 'thesis_generator' },
        triggeredBy: 'user_manual',
      });
      throw new BadRequestException(
        `Lisa n'a pas pu produire une proposition exploitable (${msg.slice(0, 150)}). Réessaie dans un instant — les parse failures Claude sont rares et transitoires.`,
      );
    }

    // Enforce risk constraints (structural safety net)
    const enforcement = this.riskEnforcer.enforce(result.proposal);
    const finalProposal = enforcement.adjustedProposal ?? result.proposal;

    if (!enforcement.adjustedProposal) {
      throw new BadRequestException(`Proposal rejected by risk enforcer: ${enforcement.summary}`);
    }

    // Persist proposal
    await this.supabase.getClient().from('lisa_proposals').insert({
      id: finalProposal.id,
      user_id: userId,
      portfolio_id: portfolioId,
      capital_usd: finalProposal.capitalUsd,
      base_currency: finalProposal.baseCurrency,
      detected_regime: finalProposal.detectedRegime,
      market_momentum: finalProposal.marketMomentum,
      regime_summary: finalProposal.regimeSummary,
      favored_pockets: finalProposal.favoredPockets,
      avoided_pockets: finalProposal.avoidedPockets,
      theses: finalProposal.theses,
      allocations: finalProposal.allocations,
      cash_reserve_pct: finalProposal.cashReservePct,
      portfolio_risk_lens: finalProposal.portfolioRiskLens,
      constraints_used: finalProposal.constraints,
      warnings: [...finalProposal.warnings, ...enforcement.violations.map((v) => v.message)],
      status: 'proposed',
      claude_model: result.claudeMeta.model,
      claude_input_tokens: result.claudeMeta.inputTokens,
      claude_output_tokens: result.claudeMeta.outputTokens,
      claude_cost_usd: result.costUsd,
      generated_at: finalProposal.generatedAt,
      expires_at: new Date(Date.now() + 3600_000).toISOString(), // 1h validity
      close_recommendations: result.closeRecommendations ?? [],
    });

    // Decision log
    await this.logDecision(portfolioId, 'proposal_generated', {
      summary: `Lisa generated ${finalProposal.theses.length} theses, regime=${finalProposal.detectedRegime}`,
      rationale: finalProposal.regimeSummary,
      payload: { proposalId: finalProposal.id, costUsd: result.costUsd },
      triggeredBy: 'user_manual',
    });

    // Écrire la directive mécanique — l'agent sans-LLM l'utilise pendant 35 min
    await this.writeDirective(portfolioId, finalProposal, result.closeRecommendations ?? [], trajectoryStatus, config.profile as SessionProfile).catch(
      (e) => this.logger.warn(`writeDirective failed (non-blocking): ${String(e)}`),
    );

    return finalProposal;
  }

  /**
   * Extrait et persiste une directive mécanique depuis la proposal Claude.
   * L'agent MechanicalTradingService consomme cette directive toutes les minutes
   * pour ouvrir/fermer des positions sans appel LLM.
   */
  private async writeDirective(
    portfolioId: string,
    proposal: AllocationProposal,
    closeRecommendations: Array<{ positionId: string; reason: string }>,
    trajectoryStatus: TrajectoryStatus | null,
    profile: SessionProfile,
  ): Promise<void> {
    // Extraire les thèmes depuis favored_pockets
    const activeThemes = proposal.favoredPockets.map((p) => p.assetClass);
    const favoredAssetClasses = [...new Set(proposal.favoredPockets.map((p) => p.assetClass))];
    const avoidedAssetClasses = [...new Set(proposal.avoidedPockets.map((p) => p.assetClass))];

    const isHyperActive = profile === 'hyper_active';

    // Posture de risque : trajectoire PRIME sur momentum
    //  - HORS_TRAJECTOIRE → defensive (protège le capital, pas de nouvelles ouvertures)
    //    SAUF si profile=hyper_active : l'utilisateur a explicitement choisi
    //    haute fréquence + cible ambitieuse — defensive paralyserait tout.
    //    On passe alors en 'aggressive' pour forcer le rattrapage actif.
    //  - EN_RETARD + momentum bullish → aggressive (rattrape le retard)
    //  - EN_AVANCE → normal (pas besoin de forcer)
    //  - DANS_LE_PLAN → basé sur momentum
    let riskPosture: 'aggressive' | 'normal' | 'defensive';
    if (trajectoryStatus === 'HORS_TRAJECTOIRE') {
      riskPosture = isHyperActive ? 'aggressive' : 'defensive';
    } else if (trajectoryStatus === 'EN_RETARD' && proposal.marketMomentum !== 'bearish') {
      riskPosture = 'aggressive';
    } else if (trajectoryStatus === 'EN_AVANCE') {
      riskPosture = 'normal';
    } else {
      riskPosture =
        proposal.marketMomentum === 'bullish_strong' ? 'aggressive' :
        proposal.marketMomentum === 'bearish' ? 'defensive' : 'normal';
    }

    // Construire target_symbols depuis les thèses + allocations.
    //
    // Si l'expression Lisa choisit une direction `long_call` ou `long_put`,
    // on injecte un optionStructure avec defaults raisonnables (DTE 14,
    // OTM 2%, IV 0.30). Le mechanical-trading routera vers OptionBroker
    // si enable_derivatives=true. Sinon, fallback equity classique.
    const targetSymbols = proposal.theses.flatMap((thesis) => {
      const alloc = proposal.allocations.find((a) => a.thesisId === thesis.id);
      if (!alloc) return [];
      const expr = thesis.expressions[thesis.preferredExpressionIndex];
      if (!expr) return [];

      const stopPct = Math.abs(thesis.riskReward.adverseScenarioReturnPct ?? 2);
      const tpPct = thesis.riskReward.centralScenarioReturnPct?.mid ?? stopPct * 2;
      const horizonDays = thesis.riskReward.horizonDays ?? 3;

      const isOptionLong = expr.direction === 'long_call' || expr.direction === 'long_put';
      const direction: 'long' | 'short' = isOptionLong
        ? expr.direction === 'long_call' ? 'long' : 'short'
        : (expr.direction === 'long' || expr.direction === 'short' ? expr.direction : 'long');

      return [{
        symbol: expr.symbol,
        assetClass: expr.assetClass,
        direction,
        stopLossPct: Math.max(stopPct, 0.5),
        takeProfitPct: Math.max(tpPct, 0.5),
        convictionScore: Math.round(thesis.confidenceScore / 10),
        horizonDays,
        venue: expr.preferredVenue,
        thesisId: thesis.id,
        ...(isOptionLong
          ? {
              optionStructure: {
                strikeOtmPct: 2,                              // ATM+2% par défaut
                dteDays: Math.max(7, Math.min(45, horizonDays * 3)), // DTE = ~3× horizon, borné [7, 45]
                iv: 0.30,                                     // IV constante
              },
            }
          : {}),
      }];
    });

    // close_conditions depuis les closeRecommendations de Lisa
    const closeConditions = closeRecommendations.map((r) => ({
      positionId: r.positionId,
      reason: r.reason,
      urgency: 'immediate' as const,
    }));

    const validUntil = new Date(Date.now() + 35 * 60_000).toISOString();

    // Parser les warnings [AGENT] {...} → tactical_overrides JSON
    // (format strict : une ligne, JSON valide strict après le préfixe)
    const tacticalOverrides = this.parseAgentDirectives(proposal.warnings ?? []);

    const { error } = await this.supabase.getClient()
      .from('lisa_mechanical_directives')
      .insert({
        portfolio_id: portfolioId,
        market_momentum: proposal.marketMomentum ?? 'neutral',
        trajectory_status: trajectoryStatus ?? 'DANS_LE_PLAN',
        active_themes: activeThemes,
        favored_asset_classes: favoredAssetClasses,
        avoided_asset_classes: avoidedAssetClasses,
        target_symbols: targetSymbols,
        close_conditions: closeConditions,
        risk_posture: riskPosture,
        tactical_overrides: tacticalOverrides,
        source_proposal_id: proposal.id,
        generated_at: new Date().toISOString(),
        valid_until: validUntil,
      });

    if (error) {
      // Log all directive write errors with enough context to diagnose migration issues
      this.logger.warn(`writeDirective DB error: ${error.message} — apply migrations 0051/0053 if missing columns`);
      return;
    }

    // Purger les directives > 2h pour ce portfolio
    void this.supabase.getClient()
      .from('lisa_mechanical_directives')
      .delete()
      .eq('portfolio_id', portfolioId)
      .lt('generated_at', new Date(Date.now() - 2 * 3_600_000).toISOString());

    this.logger.log(`Directive mécanique écrite — ${targetSymbols.length} symboles cibles, validité 35 min${
      Object.keys(tacticalOverrides).length > 0 ? `, overrides: ${Object.keys(tacticalOverrides).join(',')}` : ''
    }`);
  }

  /**
   * Parse les warnings préfixés [AGENT] {...} en un objet tactical_overrides
   * strict. Les entrées malformées ou avec clés inconnues sont ignorées
   * silencieusement (fail-safe : l'agent fonctionne toujours sur les défauts).
   *
   * Clés acceptées :
   *  - pauseOpens: boolean
   *  - pauseOpensReason: enum ('stops_cluster'|'vix_spike'|'drawdown'|'exposure_high'|'choppiness'|'regime_break')
   *  - tightenStopsMultiplier: number (borné [0.3, 2.0])
   *  - minConvictionOverride: number (borné [0, 10])
   *  - maxNewOpensOverride: number (borné [0, 10])
   *  - closeLowestConvictionIfExposureAbovePct: number (borné [0, 100])
   *  - preferredAssetClasses: string[]
   */
  private parseAgentDirectives(warnings: string[]): Record<string, unknown> {
    const agentRe = /^\[AGENT\]\s*(\{.*\})\s*$/s;
    const VALID_REASONS = new Set(['stops_cluster', 'vix_spike', 'drawdown', 'exposure_high', 'choppiness', 'regime_break']);
    const out: Record<string, unknown> = {};

    for (const w of warnings) {
      const m = agentRe.exec(w.trim());
      if (!m) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(m[1]);
      } catch (e) {
        this.logger.warn(`[AGENT] JSON invalide, ignoré: ${m[1].slice(0, 120)}`);
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const p = parsed as Record<string, unknown>;

      if (typeof p.pauseOpens === 'boolean') out.pauseOpens = p.pauseOpens;
      if (typeof p.pauseOpensReason === 'string' && VALID_REASONS.has(p.pauseOpensReason)) {
        out.pauseOpensReason = p.pauseOpensReason;
      }
      if (typeof p.tightenStopsMultiplier === 'number' && Number.isFinite(p.tightenStopsMultiplier)) {
        out.tightenStopsMultiplier = Math.max(0.3, Math.min(2.0, p.tightenStopsMultiplier));
      }
      if (typeof p.minConvictionOverride === 'number' && Number.isFinite(p.minConvictionOverride)) {
        out.minConvictionOverride = Math.max(0, Math.min(10, Math.round(p.minConvictionOverride)));
      }
      if (typeof p.maxNewOpensOverride === 'number' && Number.isFinite(p.maxNewOpensOverride)) {
        out.maxNewOpensOverride = Math.max(0, Math.min(10, Math.round(p.maxNewOpensOverride)));
      }
      if (typeof p.closeLowestConvictionIfExposureAbovePct === 'number' && Number.isFinite(p.closeLowestConvictionIfExposureAbovePct)) {
        out.closeLowestConvictionIfExposureAbovePct = Math.max(0, Math.min(100, p.closeLowestConvictionIfExposureAbovePct));
      }
      if (Array.isArray(p.preferredAssetClasses) && p.preferredAssetClasses.every((x) => typeof x === 'string')) {
        out.preferredAssetClasses = p.preferredAssetClasses;
      }
    }

    return out;
  }

  async approveProposal(userId: string, proposalId: string): Promise<{ openedPositions: PaperPosition[]; skipped: number; closedRecommended: number }> {
    const { data: proposal, error } = await this.supabase.getClient()
      .from('lisa_proposals')
      .select('*')
      .eq('id', proposalId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !proposal) throw new NotFoundException('Proposal introuvable');
    if (proposal.status !== 'proposed') {
      throw new BadRequestException(`Proposal status = ${proposal.status}, cannot approve`);
    }

    const portfolioId = proposal.portfolio_id as string;
    const theses = proposal.theses as Array<Record<string, unknown>>;
    const allocationsRaw = proposal.allocations as Array<{ thesisId: string; pctCapital: number; amountUsd: string }>;
    const closeRecommendations = (proposal.close_recommendations as Array<{ positionId: string; reason: string }> | null) ?? [];
    const marketMomentum = (proposal.market_momentum as 'bullish_strong' | 'neutral' | 'bearish' | null) ?? 'neutral';

    // Stop-loss plus serré si le portefeuille est en mode agressif (chasseuse EV+)
    // + cap d'ouvertures par cycle modulé par le marketMomentum.
    const { data: sessionCfg } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    const aggressive = sessionCfg?.autopilot_aggressive === true;

    // Cap effectif par régime. Base vient du config (default 2).
    // Appliqué UNIQUEMENT en mode autopilot (auto_approve) pour ne pas
    // restreindre les approbations manuelles volontaires de l'utilisateur.
    const capBase = Math.max(1, Math.min(7, Number(sessionCfg?.autopilot_max_opens_per_cycle ?? 2)));
    const autopilotActive = sessionCfg?.autopilot_enabled === true && sessionCfg?.autopilot_auto_approve === true;
    let effectiveCap = allocationsRaw.length;
    if (autopilotActive) {
      if (marketMomentum === 'bullish_strong') effectiveCap = capBase * 2;
      else if (marketMomentum === 'bearish') effectiveCap = Math.max(1, Math.floor(capBase / 2));
      else effectiveCap = capBase;
    }

    // On garde les N allocations à plus haute conviction (pctCapital desc
    // = sizing Claude, proxy de sa conviction relative). Les rejetées sont
    // loggées pour traçabilité.
    const allocations = allocationsRaw.length > effectiveCap
      ? [...allocationsRaw].sort((a, b) => b.pctCapital - a.pctCapital).slice(0, effectiveCap)
      : allocationsRaw;
    const cappedOut = allocationsRaw.length - allocations.length;
    if (cappedOut > 0) {
      const keptIds = new Set(allocations.map((a) => a.thesisId));
      const rejected = allocationsRaw.filter((a) => !keptIds.has(a.thesisId));
      await this.logDecision(portfolioId, 'proposal_capped_by_cycle_limit', {
        summary: `Cap d'ouvertures : ${cappedOut} thèse(s) écartée(s) ce cycle (momentum=${marketMomentum}, cap=${effectiveCap})`,
        rationale: `Garde-fou anti-burst : le cycle ne peut pas ouvrir plus de ${effectiveCap} position(s) selon le momentum détecté. Les thèses écartées sont les moins sized par Claude. Le prochain cycle (après cooldown) pourra les reprendre si elles restent pertinentes.`,
        payload: { marketMomentum, effectiveCap, capBase, rejectedThesisIds: rejected.map((a) => a.thesisId) },
        triggeredBy: 'user_manual',
      });
    }

    // 1. D'abord on exécute les fermetures recommandées par Lisa — libère du
    //    cash avant d'ouvrir les nouvelles positions.
    let closedRecommended = 0;
    const openPositions = await this.paperBroker.getPositions(portfolioId, true);
    for (const rec of closeRecommendations) {
      const pos = openPositions.find((p) => p.id === rec.positionId);
      if (!pos) {
        this.logger.warn(`Close rec skipped — position ${rec.positionId} non trouvée ou déjà fermée`);
        continue;
      }
      try {
        const quote = await this.fetchLivePrice(pos.symbol);
        await this.paperBroker.closePosition({
          positionId: pos.id,
          reason: 'closed_invalidated',
          livePrice: quote.price,
          rationale: `Lisa recommendation: ${rec.reason}`.slice(0, 500),
        });
        closedRecommended++;
        await this.logDecision(portfolioId, 'position_closed_by_lisa', {
          summary: `Lisa closed ${pos.symbol} (${pos.id.slice(0, 8)}): ${rec.reason}`.slice(0, 200),
          rationale: rec.reason,
          payload: { positionId: pos.id, symbol: pos.symbol },
          triggeredBy: 'user_manual',
        });
      } catch (e) {
        this.logger.warn(`Close recommendation failed for ${pos.symbol}: ${String(e)}`);
      }
    }

    // 1bis. Cooldown check — bloque les nouvelles ouvertures si une position
    // vient d'être ouverte récemment ET que le momentum n'est pas bullish_strong.
    // Bullish_strong bypasse le cooldown pour garder la réactivité maximale
    // en fenêtre haussière confirmée. Ne s'applique qu'en mode autopilot.
    // Les fermetures ont déjà été exécutées ci-dessus : elles ne sont jamais
    // bloquées par le cooldown.
    const opened: PaperPosition[] = [];
    let skipped = 0;
    let cooldownSkipped = false;

    if (autopilotActive && marketMomentum !== 'bullish_strong' && allocations.length > 0) {
      // Default cooldown : 5 min en hyper_active (cadence haute fréquence
      // explicite), 15 min sinon. L'utilisateur peut surcharger via
      // autopilot_opening_cooldown_minutes côté config.
      const cooldownDefault = sessionCfg?.profile === 'hyper_active' ? 5 : 15;
      const cooldownBase = Math.max(0, Math.min(240, Number(sessionCfg?.autopilot_opening_cooldown_minutes ?? cooldownDefault)));
      const cooldownMultiplier = marketMomentum === 'bearish' ? 1.33 : 1;
      const effectiveCooldownMs = Math.round(cooldownBase * cooldownMultiplier) * 60_000;

      if (effectiveCooldownMs > 0) {
        const { data: lastOpen } = await this.supabase.getClient()
          .from('lisa_decision_log')
          .select('timestamp')
          .eq('portfolio_id', portfolioId)
          .eq('kind', 'position_opened')
          .order('timestamp', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (lastOpen) {
          const elapsedMs = Date.now() - new Date(lastOpen.timestamp as string).getTime();
          if (elapsedMs < effectiveCooldownMs) {
            const remaining = Math.ceil((effectiveCooldownMs - elapsedMs) / 60_000);
            await this.logDecision(portfolioId, 'proposal_cooldown_active', {
              summary: `Cooldown ouvertures actif — ${allocations.length} thèse(s) ignorée(s) (${remaining}min restants, momentum=${marketMomentum})`,
              rationale: `Garde-fou anti-burst : une position a été ouverte il y a ${Math.round(elapsedMs / 60_000)}min ; cooldown effectif = ${Math.round(effectiveCooldownMs / 60_000)}min pour momentum "${marketMomentum}". Seul marketMomentum='bullish_strong' bypasse ce cooldown. Fermetures restent actives.`,
              payload: { marketMomentum, effectiveCooldownMinutes: Math.round(effectiveCooldownMs / 60_000), remainingMinutes: remaining, skippedAllocations: allocations.length },
              triggeredBy: 'user_manual',
            });
            skipped = allocations.length;
            cooldownSkipped = true;
          }
        }
      }
    }

    // 2. Récupère le cash disponible avant d'ouvrir des nouvelles positions.
    //    Gate STRICT : pas de leverage implicite, pas de cash négatif.
    const snapshot = await this.paperBroker.computeSnapshot(portfolioId);
    let availableCash = new Decimal(snapshot.cashUsd);
    const CASH_BUFFER_USD = new Decimal('50'); // marge de sécurité (slippage + frais)

    const allocationsToOpen = cooldownSkipped ? [] : allocations;
    for (const alloc of allocationsToOpen) {
      const thesis = theses.find((t) => t.id === alloc.thesisId);
      if (!thesis) continue;

      const expressions = thesis.expressions as Array<Record<string, unknown>>;
      const preferredIdx = (thesis.preferredExpressionIndex as number) ?? 0;
      const expression = expressions[preferredIdx];
      if (!expression) continue;

      const allocAmount = new Decimal(alloc.amountUsd);
      if (availableCash.minus(allocAmount).lt(CASH_BUFFER_USD)) {
        this.logger.warn(
          `Skip ${String(expression.symbol)}: cash ${availableCash.toFixed(2)} insuffisant pour ${allocAmount.toFixed(2)}`,
        );
        skipped++;
        await this.logDecision(portfolioId, 'position_skipped_insufficient_cash', {
          summary: `Skip ${String(expression.symbol)} (${alloc.amountUsd} USD) — cash dispo ${availableCash.toFixed(2)} USD`,
          rationale: `Respect du cap anti-leverage : cash + buffer ${CASH_BUFFER_USD} requis`,
          payload: { thesisId: alloc.thesisId, allocAmount: alloc.amountUsd, cashAvailable: availableCash.toFixed(2) },
          triggeredBy: 'user_manual',
        });
        continue;
      }

      try {
        const quote = await this.fetchLivePrice(expression.symbol as string);
        const riskReward = thesis.riskReward as { horizonDays: number; adverseScenarioReturnPct?: number };
        const assetClass = String(expression.assetClass ?? '');
        const isCrypto = assetClass.startsWith('crypto_');

        // Stop-loss OBLIGATOIRE : -5% par défaut, ou le scénario adverse de la
        // thèse si plus strict. Permet à la risk_monitor de fermer les perdantes.
        const direction = expression.direction as string;
        const livePx = new Decimal(quote.price);
        const adversePct = Math.abs(riskReward.adverseScenarioReturnPct ?? -5);
        // Aggressive mode = stop plus serré (-2% floor au lieu de -3%) pour
        // couper vite les perdantes et libérer du cash pour la prochaine idée.
        const floor = aggressive ? 2 : 3;
        const ceil = aggressive ? 5 : 10;
        const stopPct = Math.min(Math.max(adversePct, floor), ceil) / 100;
        const stopLossPrice = direction === 'long' || direction === 'long_call' || direction === 'long_put'
          ? livePx.mul(new Decimal(1).minus(new Decimal(stopPct))).toFixed(8)
          : livePx.mul(new Decimal(1).plus(new Decimal(stopPct))).toFixed(8);

        const binanceResult = isCrypto
          ? await this.tryBinanceExecution(expression.symbol as string, alloc.amountUsd, quote.price)
          : null;

        const pos = await this.paperBroker.openPosition({
          portfolioId,
          proposalId,
          thesisId: alloc.thesisId,
          expressionIndex: preferredIdx,
          capitalAllocationUsd: alloc.amountUsd,
          livePrice: quote.price,
          stopLossPrice,
          takeProfitPrice: null,
          horizonDays: riskReward.horizonDays ?? 30,
        });
        opened.push(pos);
        availableCash = availableCash.minus(allocAmount);

        await this.logDecision(portfolioId, 'position_opened', {
          summary: `Opened ${expression.symbol}: ${alloc.pctCapital}% (${alloc.amountUsd} USD) at ${quote.price} stop=${stopLossPrice}`,
          rationale: String(thesis.summary),
          payload: {
            positionId: pos.id,
            thesisId: alloc.thesisId,
            stopLossPrice,
            binanceOrderId: binanceResult?.externalOrderId ?? null,
            executionRoute: binanceResult ? 'binance_live' : 'paper',
          },
          triggeredBy: 'user_manual',
        });
      } catch (e) {
        this.logger.error(`Failed to open position for ${String(expression.symbol)}: ${String(e)}`);
      }
    }

    // Mark proposal as executed
    await this.supabase.getClient()
      .from('lisa_proposals')
      .update({ status: 'executed', executed_at: new Date().toISOString() })
      .eq('id', proposalId);

    return { openedPositions: opened, skipped, closedRecommended };
  }

  async rejectProposal(userId: string, proposalId: string, reason: string): Promise<void> {
    const { error } = await this.supabase.getClient()
      .from('lisa_proposals')
      .update({ status: 'rejected' })
      .eq('id', proposalId)
      .eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);

    await this.logDecision(proposalId, 'proposal_rejected', {
      summary: `Proposal rejected by user`,
      rationale: reason,
      payload: { proposalId },
      triggeredBy: 'user_manual',
    });
  }

  /**
   * Purge en masse des propositions anciennes. Supprime celles dont le
   * status est terminal (executed/rejected/expired) OU plus vieilles que
   * olderThanHours (défaut 24h). Préserve les propositions "proposed"
   * récentes en attente d'approbation utilisateur.
   */
  async purgeOldProposals(
    userId: string,
    portfolioId: string,
    olderThanHours = 24,
  ): Promise<{ deleted: number }> {
    await this.assertPortfolioOwner(userId, portfolioId);
    const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString();

    // Comptage d'abord pour retour au user
    const { count: beforeCount } = await this.supabase.getClient()
      .from('lisa_proposals')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId);

    // Delete : propositions terminales peu importe l'âge OU propositions
    // de toute status si plus vieilles que le cutoff.
    const { error } = await this.supabase.getClient()
      .from('lisa_proposals')
      .delete()
      .eq('portfolio_id', portfolioId)
      .or(`status.in.(executed,rejected,expired),generated_at.lt.${cutoff}`);

    if (error) throw new BadRequestException(`Purge failed: ${error.message}`);

    const { count: afterCount } = await this.supabase.getClient()
      .from('lisa_proposals')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId);

    const deleted = (beforeCount ?? 0) - (afterCount ?? 0);

    await this.logDecision(portfolioId, 'proposals_purged', {
      summary: `${deleted} proposition(s) ancienne(s) purgée(s)`,
      rationale: `Cutoff : ${cutoff}. Critères : status terminal OU âge > ${olderThanHours}h.`,
      payload: { deleted, olderThanHours, cutoff },
      triggeredBy: 'user_manual',
    });

    return { deleted };
  }

  async listProposals(userId: string, portfolioId: string, limit = 20) {
    const { data, error } = await this.supabase.getClient()
      .from('lisa_proposals')
      .select('*')
      .eq('user_id', userId)
      .eq('portfolio_id', portfolioId)
      .order('generated_at', { ascending: false })
      .limit(limit);
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  // ── Positions + snapshots ──────────────────────────────────────────────────

  async listPositions(userId: string, portfolioId: string, openOnly = false) {
    await this.assertPortfolioOwner(userId, portfolioId);
    return this.paperBroker.getPositions(portfolioId, openOnly);
  }

  async getCurrentSnapshot(userId: string, portfolioId: string) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const snap = await this.paperBroker.computeSnapshot(portfolioId);
    // Transform camelCase PortfolioSnapshot → snake_case to match LisaSnapshot frontend type
    return {
      id: snap.id,
      portfolio_id: snap.portfolioId,
      timestamp: snap.timestamp,
      cash_usd: snap.cashUsd,
      open_positions_value_usd: snap.openPositionsValueUsd,
      total_value_usd: snap.totalValueUsd,
      realized_pnl_cumulative_usd: snap.realizedPnlCumulativeUsd,
      unrealized_pnl_usd: snap.unrealizedPnlUsd,
      return_from_inception_pct: snap.returnFromInceptionPct,
      open_positions_count: snap.openPositionsCount,
      drawdown_from_peak_pct: snap.drawdownFromPeakPct,
    };
  }

  async getSnapshotHistory(userId: string, portfolioId: string, windowDays: number) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const { data, error } = await this.supabase.getClient()
      .from('lisa_portfolio_snapshots')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .gte('timestamp', since)
      .order('timestamp', { ascending: true });
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async getDecisionLog(userId: string, portfolioId: string, limit = 50) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const { data, error } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .order('timestamp', { ascending: false })
      .limit(limit);
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async runRiskCheck(userId: string, portfolioId: string) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const config = await this.getSessionConfig(userId, portfolioId);
    if (!config) throw new NotFoundException('Session config introuvable');

    const constraints = (config.risk_constraints as LisaSessionConfig['riskConstraints']) ?? {
      maxDrawdown2DaysPct: 10,
      maxDrawdown7DaysPct: 15,
      maxDrawdown30DaysPct: 25,
      maxPositionSizePct: 25,
      maxOpenPositions: 10,
      maxLeverage: 1.5,
      maxExposurePerAssetClassPct: 40,
      maxPortfolioVolatilityPct: 20,
      autoLiquidateOnKill: true,
    };

    return this.riskMonitor.checkPortfolio(portfolioId, constraints);
  }

  /**
   * Reset complet de la simulation : supprime TOUTES les positions, snapshots
   * et decision log pour ce portefeuille. Utile pour effacer un état corrompu
   * (ex : positions ouvertes avec prix fallback avant live feed disponible).
   * À la différence du kill-switch, ne matérialise PAS de P&L réalisé.
   */
  async resetSimulation(userId: string, portfolioId: string) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const client = this.supabase.getClient();

    const [posRes, snapRes, logRes, propRes] = await Promise.all([
      client.from('lisa_positions').delete().eq('portfolio_id', portfolioId),
      client.from('lisa_portfolio_snapshots').delete().eq('portfolio_id', portfolioId),
      client.from('lisa_decision_log').delete().eq('portfolio_id', portfolioId),
      client.from('lisa_proposals').delete().eq('portfolio_id', portfolioId),
    ]);

    const errors = [posRes.error, snapRes.error, logRes.error, propRes.error].filter(Boolean);
    if (errors.length) {
      throw new BadRequestException(`Reset partiel — erreurs : ${errors.map((e) => e!.message).join(' | ')}`);
    }

    // Réactive la config (lève kill_switch éventuel posé avant)
    await client
      .from('lisa_session_configs')
      .update({ kill_switch_active: false })
      .eq('portfolio_id', portfolioId);

    return { ok: true, portfolioId };
  }

  async triggerKillSwitch(userId: string, portfolioId: string, reason: string) {
    await this.assertPortfolioOwner(userId, portfolioId);

    await this.supabase.getClient()
      .from('lisa_session_configs')
      .update({ kill_switch_active: true, autopilot_enabled: false })
      .eq('portfolio_id', portfolioId);

    // Force-close all open positions
    const openPositions = await this.paperBroker.getPositions(portfolioId, true);
    for (const pos of openPositions) {
      try {
        const quote = await this.fetchLivePrice(pos.symbol);
        await this.paperBroker.closePosition({
          positionId: pos.id,
          reason: 'closed_kill',
          livePrice: quote.price,
          rationale: `User kill switch: ${reason}`,
        });
      } catch (e) {
        this.logger.error(`Kill switch close failed for ${pos.symbol}: ${String(e)}`);
      }
    }

    await this.logDecision(portfolioId, 'kill_switch_triggered', {
      summary: `User triggered kill switch — all ${openPositions.length} positions closed`,
      rationale: reason,
      payload: { closedCount: openPositions.length },
      triggeredBy: 'user_manual',
    });

    return { closedPositions: openPositions.length };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async assertPortfolioOwner(userId: string, portfolioId: string): Promise<void> {
    const { data, error } = await this.supabase.getClient()
      .from('portfolios')
      .select('id')
      .eq('id', portfolioId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) throw new NotFoundException('Portfolio introuvable');
  }

  /**
   * Attempt to execute a crypto order on Binance when the full guard chain is active:
   *   BINANCE_API_KEY + BINANCE_SECRET_KEY set in env
   *   BINANCE_EXECUTION_ENABLED=true
   * Returns null (paper-only) when any condition is not met.
   * Never throws — execution failure is logged but does not block paper position creation.
   */
  private async tryBinanceExecution(
    symbol: string,
    capitalUsd: string,
    livePrice: string,
  ): Promise<{ externalOrderId: string | null; status: string } | null> {
    // Nom de variable choisi par l'utilisateur sur Railway
    const apiKey = this.config.get<string>('smartvest-lisa') ?? this.config.get<string>('BINANCE_API_KEY');
    const secretKey = this.config.get<string>('BINANCE_SECRET_KEY');
    const execEnabled = this.config.get<string>('BINANCE_EXECUTION_ENABLED') === 'true';

    if (!apiKey || !secretKey || !execEnabled) return null;

    try {
      const adapter = new BinanceAdapter(true);
      await adapter.connect({ provider: 'BINANCE', apiKey, secretKey });

      // Compute quantity from capital / price
      const qty = new Decimal(capitalUsd).dividedBy(new Decimal(livePrice));
      // Binance requires symbol without dashes: BTC → BTCUSDT
      const binanceSymbol = this.toBinanceSymbol(symbol);

      const result = await adapter.placeOrder({
        accountIdExternal: 'spot',
        instrumentRef: binanceSymbol,
        side: 'buy',
        orderType: 'market',
        quantity: qty.toFixed(6),
      });

      this.logger.log(`Binance order: ${binanceSymbol} qty=${qty.toFixed(6)} → ${result.status} orderId=${result.externalOrderId}`);

      if (result.status === 'rejected') {
        this.logger.warn(`Binance order rejected: ${result.message}`);
      }

      return result;
    } catch (e) {
      this.logger.error(`Binance execution error for ${symbol}: ${String(e)}`);
      return null;
    }
  }

  /** Convert ticker to Binance USDT pair symbol (e.g. BTC → BTCUSDT) */
  private toBinanceSymbol(symbol: string): string {
    const s = symbol.toUpperCase().replace(/[/\-\s]/g, '');
    // Already has USDT suffix
    if (s.endsWith('USDT')) return s;
    // Stablecoins — no pair needed, but return as-is
    if (['USDT', 'USDC', 'BUSD'].includes(s)) return s;
    return `${s}USDT`;
  }

  /**
   * Fetch live price via EODHD real-time API.
   * Falls back to Supabase quotes cache, then to a static fallback.
   */
  /** Public wrapper for the price warmer (autopilot cron). */
  async warmPrice(symbol: string): Promise<void> {
    await this.fetchLivePrice(symbol);
  }

  /** Public price fetch — used by MechanicalTradingService (no Claude cost). */
  async getLivePrice(symbol: string): Promise<{ symbol: string; price: string; asOf: string; source: string }> {
    return this.fetchLivePrice(symbol);
  }

  /**
   * Cross-validation oracle pour les indicateurs macro (VIX, DXY).
   *
   * Le brief mécanique appelle `getLivePrice` qui passe par `toEodhdTicker`
   * et un fallback générique (historique de bugs : VIX=100 si EODHD échoue).
   * Cette méthode est un SECOND oracle indépendant qui contacte directement
   * EODHD avec le ticker indice (^VIX.INDX, DX-Y.NYB.FOREX) et fallback
   * sur des valeurs réalistes (18.5, 102.3). Si la valeur retournée par
   * les deux oracles diverge au-delà du seuil, le consumer décide de
   * traiter comme donnée non-fiable.
   *
   * Aucun coût Claude — appel HTTP EODHD direct (gratuit dans le quota).
   */
  async fetchMacroIndicator(
    key: 'VIX' | 'DXY',
  ): Promise<{ value: number; source: 'eodhd' | 'fallback' }> {
    const ticker = key === 'VIX' ? '^VIX.INDX' : 'DX-Y.NYB.FOREX';
    const fallback = key === 'VIX' ? 18.5 : 102.3;
    const eodhKey = this.config.get<string>('EODHD_API_KEY');

    if (!eodhKey || eodhKey === 'demo') {
      return { value: fallback, source: 'fallback' };
    }

    try {
      const url = `https://eodhd.com/api/real-time/${encodeURIComponent(ticker)}?api_token=${eodhKey}&fmt=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { value: fallback, source: 'fallback' };
      const d = (await res.json()) as Record<string, unknown>;
      const v = Number(d['close'] ?? d['previousClose'] ?? d['open']);
      if (!Number.isFinite(v) || v <= 0) return { value: fallback, source: 'fallback' };
      return { value: v, source: 'eodhd' };
    } catch {
      return { value: fallback, source: 'fallback' };
    }
  }

  private async fetchLivePrice(symbol: string): Promise<{ symbol: string; price: string; asOf: string; source: string }> {
    const eodhKey = this.config.get<string>('EODHD_API_KEY');
    const now = new Date().toISOString();
    let eodhdTicker: string | null = null;

    // 0. Realtime cache (Binance WS pour crypto, refresh EODHD pour le reste)
    const cached = this.realtimePrice.getCached(symbol);
    if (cached) {
      return { symbol, price: cached.price, asOf: cached.asOf, source: cached.source };
    }

    // Hard cap EODHD : si quota jour dépassé, on renvoie le cache même
    // périmé (ou fallback statique) pour ne pas violer la limite 100k/j.
    const quotaStatus = await this.realtimePrice.canCallEodhd();
    if (quotaStatus === 'blocked') {
      // Essai dernière chance : cache même trop vieux
      const anyCached = this.realtimePrice.snapshot().find((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
      if (anyCached) {
        return { symbol, price: anyCached.price, asOf: new Date(Date.now() - anyCached.ageMs).toISOString(), source: `${anyCached.source}_stale` };
      }
      return { symbol, price: this.getFallbackPrice(symbol), asOf: now, source: 'fallback_quota_cap' };
    }

    // 1. Try EODHD real-time endpoint
    if (eodhKey && eodhKey !== 'demo') {
      const tStart = Date.now();
      // Enregistre le call dans la sliding window RATE LIMIT 1000/min
      this.realtimePrice.recordEodhdCall();
      try {
        eodhdTicker = this.toEodhdTicker(symbol);
        const url = `https://eodhd.com/api/real-time/${encodeURIComponent(eodhdTicker)}?api_token=${eodhKey}&fmt=json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const latencyMs = Date.now() - tStart;
        if (res.ok) {
          const data = await res.json() as Record<string, unknown>;
          const price = data['close'] ?? data['previousClose'] ?? data['open'];
          if (price && Number(price) > 0) {
            this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'eodhd', success: true, statusCode: res.status, latencyMs, priceUsd: Number(price), calledBy: 'live_price' });
            this.realtimePrice.setCached(symbol, String(price), 'eodhd', now);
            return { symbol, price: String(price), asOf: now, source: 'eodhd' };
          }
          this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'eodhd', success: false, statusCode: res.status, latencyMs, calledBy: 'live_price', errorMessage: 'empty_price_field' });
        } else {
          this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'eodhd', success: false, statusCode: res.status, latencyMs, calledBy: 'live_price', errorMessage: `HTTP_${res.status}` });
        }
      } catch (e) {
        this.logger.warn(`EODHD price fetch failed for ${symbol}: ${String(e)}`);
        this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'eodhd', success: false, latencyMs: Date.now() - tStart, calledBy: 'live_price', errorMessage: String(e).slice(0, 200) });
      }
    }

    // 2. Supabase quotes cache
    const { data: quote } = await this.supabase.getClient()
      .from('quotes')
      .select('price, as_of')
      .ilike('asset_id', `%${symbol}%`)
      .order('as_of', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (quote) {
      this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'supabase_quotes', success: true, priceUsd: Number(quote.price), calledBy: 'live_price' });
      return { symbol, price: String(quote.price), asOf: quote.as_of as string, source: 'supabase_quotes' };
    }

    // 3. Static fallback (simulation still works without live data)
    this.logger.warn(`No quote found for ${symbol}, returning fallback price`);
    const fallback = this.getFallbackPrice(symbol);
    this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'fallback', success: true, priceUsd: Number(fallback), calledBy: 'live_price' });
    return { symbol, price: fallback, asOf: now, source: 'fallback' };
  }

  /**
   * Log fire-and-forget d'un appel EODHD (ou équivalent). Ne JAMAIS bloquer
   * le chemin live-price — on swallow les erreurs et on n'attend pas la promesse.
   */
  private logEodhdCall(row: {
    ticker: string;
    eodhdTicker: string | null;
    source: 'eodhd' | 'fallback' | 'supabase_quotes';
    success: boolean;
    statusCode?: number;
    latencyMs?: number;
    priceUsd?: number;
    calledBy: 'live_price' | 'market_snapshot';
    errorMessage?: string;
  }): void {
    (async () => {
      try {
        const { error } = await this.supabase.getClient().from('eodhd_request_log').insert({
          ticker: row.ticker,
          eodhd_ticker: row.eodhdTicker,
          source: row.source,
          success: row.success,
          status_code: row.statusCode ?? null,
          latency_ms: row.latencyMs ?? null,
          price_usd: row.priceUsd ?? null,
          called_by: row.calledBy,
          error_message: row.errorMessage ?? null,
        });
        if (error) this.logger.warn(`eodhd_request_log insert failed: ${error.message}`);
      } catch { /* swallow — log is fire-and-forget */ }
    })();
  }

  /**
   * Convert SmartVest/Binance symbol to EODHD ticker format.
   * BTC → BTC-USD.CC, USDJPY → USDJPY.FOREX, AAPL → AAPL.US
   */
  private toEodhdTicker(symbol: string): string {
    const s = symbol.toUpperCase();
    const cryptoMap: Record<string, string> = {
      'BTC': 'BTC-USD.CC', 'BTCUSDT': 'BTC-USD.CC', 'BITCOIN': 'BTC-USD.CC',
      'BTC-SPOT': 'BTC-USD.CC', 'BTC-USD': 'BTC-USD.CC',
      'ETH': 'ETH-USD.CC', 'ETHUSDT': 'ETH-USD.CC', 'ETHEREUM': 'ETH-USD.CC',
      'ETH-SPOT': 'ETH-USD.CC', 'ETH-USD': 'ETH-USD.CC',
      'SOL': 'SOL-USD.CC', 'SOLUSDT': 'SOL-USD.CC',
      'BNB': 'BNB-USD.CC', 'BNBUSDT': 'BNB-USD.CC',
      'XRP': 'XRP-USD.CC', 'XRPUSDT': 'XRP-USD.CC',
      'ADA': 'ADA-USD.CC', 'ADAUSDT': 'ADA-USD.CC',
      'DOGE': 'DOGE-USD.CC', 'DOGEUSDT': 'DOGE-USD.CC',
      'DOT': 'DOT-USD.CC', 'AVAX': 'AVAX-USD.CC',
      'MATIC': 'MATIC-USD.CC', 'LINK': 'LINK-USD.CC',
      'ATOM': 'ATOM-USD.CC', 'UNI': 'UNI-USD.CC',
      'LTC': 'LTC-USD.CC', 'LTCUSDT': 'LTC-USD.CC',
    };
    if (cryptoMap[s]) return cryptoMap[s];

    // Commodities futures → remplacer par ETFs US tradables (EODHD ne couvre
    // pas les futures .COMM, mais les ETFs équivalents ont une liquidité OK).
    const commodityMap: Record<string, string> = {
      'GC.COMM': 'GLD.US', 'GOLD': 'GLD.US', 'GC': 'GLD.US', 'XAU': 'GLD.US',
      'SI.COMM': 'SLV.US', 'SILVER': 'SLV.US', 'SI': 'SLV.US', 'XAG': 'SLV.US',
      'HG.COMM': 'CPER.US', 'COPPER': 'CPER.US', 'HG': 'CPER.US',
      'NG.COMM': 'UNG.US', 'NATGAS': 'UNG.US', 'NG': 'UNG.US',
      'BZ.COMM': 'BNO.US', 'BRENT': 'BNO.US', 'BZ': 'BNO.US',
      'CL.COMM': 'USO.US', 'WTI': 'USO.US', 'CL': 'USO.US', 'OIL': 'USO.US',
      'PL.COMM': 'PPLT.US', 'PLATINUM': 'PPLT.US',
      'PA.COMM': 'PALL.US', 'PALLADIUM': 'PALL.US',
    };
    if (commodityMap[s]) return commodityMap[s];

    // Indices & volatility — pour VIX et DXY on veut la VALEUR de l'indice,
    // pas le prix d'un ETF proxy (VXX ≠ VIX spot, UUP ≈ 27 vs DXY ≈ 102).
    // Les ETFs d'actions (SPY, QQQ, DIA, IWM) restent OK comme proxy tradable.
    const indexMap: Record<string, string> = {
      'VIX': '^VIX.INDX', 'VIX.US': '^VIX.INDX', 'VIX.INDX': '^VIX.INDX',
      '^VIX': '^VIX.INDX', '^VIX.INDX': '^VIX.INDX',
      'DXY': 'DX-Y.NYB.FOREX', 'DXY.US': 'DX-Y.NYB.FOREX', 'DX-Y.NYB': 'DX-Y.NYB.FOREX',
      'DX-Y.NYB.FOREX': 'DX-Y.NYB.FOREX', '^DXY': 'DX-Y.NYB.FOREX',
      'SPX': 'SPY.US', '^SPX': 'SPY.US', 'SPX.INDX': 'SPY.US',
      'NDX': 'QQQ.US', '^NDX': 'QQQ.US', 'NDX.INDX': 'QQQ.US',
      'DJI': 'DIA.US', '^DJI': 'DIA.US',
      'RUT': 'IWM.US', '^RUT': 'IWM.US',
    };
    if (indexMap[s]) return indexMap[s];

    // Bonds & yields — ETFs ou indices yield EODHD
    const bondMap: Record<string, string> = {
      'US10Y': 'TNX.INDX', 'US10Y.BOND': 'TNX.INDX',
      'US2Y': 'IRX.INDX', 'US2Y.BOND': 'IRX.INDX',
      'US5Y': 'FVX.INDX', 'US5Y.BOND': 'FVX.INDX',
      'US30Y': 'TYX.INDX', 'US30Y.BOND': 'TYX.INDX',
      'TLT': 'TLT.US', 'IEF': 'IEF.US', 'SHY': 'SHY.US',
    };
    if (bondMap[s]) return bondMap[s];

    // Already EODHD format (contains a dot)
    if (s.includes('.')) return s;

    // FX pairs: USDJPY → USDJPY.FOREX, EUR-USD → EURUSD.FOREX
    const cleanFx = s.replace('-', '');
    const fxPairs = new Set([
      'USDJPY', 'EURUSD', 'GBPUSD', 'AUDUSD', 'USDCHF', 'USDCAD',
      'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY', 'USDMXN', 'USDINR',
      'USDCNH', 'USDBRL', 'USDTRY', 'USDZAR', 'EURCAD', 'EURCHF',
    ]);
    if (fxPairs.has(cleanFx)) return `${cleanFx}.FOREX`;

    // VIX / volatility products
    if (s === 'VXX' || s === 'UVXY' || s === 'SVXY') return `${s}.US`;

    // Default: US equity/ETF
    return `${s}.US`;
  }

  /** Approximate fallback prices (order-of-magnitude, simulation only).
   *
   * Doit couvrir tous les tickers macro que `getLivePrice` peut recevoir, sinon
   * le default `100.00` est interprété comme valeur réelle par les briefings
   * (ex. VIX=100 → choc marché simulé → cascade défensive en boucle).
   *
   * Les valeurs ici sont volontairement statiques et "plausibles", elles
   * servent uniquement de filet de sécurité quand EODHD échoue ET le cache
   * Supabase est vide. Un système de fallback ne doit JAMAIS retourner une
   * valeur cohérente dans la plage de panique d'un agent en aval.
   */
  private getFallbackPrice(symbol: string): string {
    const s = symbol.toUpperCase().replace('-', '');
    const prices: Record<string, string> = {
      // Crypto
      'BTC': '79000', 'BTCUSDT': '79000', 'BTCSPOT': '79000', 'BTCUSD': '79000',
      'ETH': '1800', 'ETHUSDT': '1800', 'ETHSPOT': '1800',
      'SOL': '130', 'BNB': '550', 'XRP': '2.1', 'ADA': '0.7',
      // Métaux & matières premières
      'GOLD': '3300', 'GC': '3300', 'GLD': '310', 'IAU': '50',
      'SILVER': '33', 'SLV': '31', 'SI': '33',
      'USO': '75', 'BRENT': '78', 'CL': '78',
      // Equity / ETFs principaux
      'SPY': '545', 'QQQ': '455', 'IWM': '195',
      'AAPL': '195', 'MSFT': '405', 'NVDA': '870', 'AMZN': '195',
      // FX (paires sans tiret)
      'USDJPY': '155', 'EURUSD': '1.08', 'GBPUSD': '1.27',
      'USDCHF': '0.90', 'AUDUSD': '0.64', 'USDCAD': '1.38',
      // Volatilité
      'VIX': '18.5', 'VXX': '18', 'UVXY': '8',
      // FX index
      'DXY': '102.3',
      // Bonds / yields (approximations en %)
      'US10Y': '4.2', 'TNX': '4.2',
      'US2Y': '3.9', 'IRX': '3.9',
      'US5Y': '4.1', 'FVX': '4.1',
      'US30Y': '4.4', 'TYX': '4.4',
      'TLT': '90', 'IEF': '95', 'HYG': '76', 'LQD': '108',
    };
    return prices[s] ?? '100.00';
  }

  /**
   * Fetch live market snapshot via EODHD for all key signals.
   * Gracefully falls back on static values if EODHD is unavailable.
   */
  private async fetchMarketSnapshot(): Promise<MarketSnapshot> {
    const eodhKey = this.config.get<string>('EODHD_API_KEY');

    // Static fallback used both as defaults and when EODHD is unavailable
    const fallback: MarketSnapshot = {
      timestamp: new Date().toISOString(),
      vix: 18.5, usdDxy: 102.3, us10yYield: 4.2, us2yYield: 3.9,
      brentUsd: 78.0, btcUsd: 105000, ethUsd: 3500, goldUsd: 3300,
      sp500: 5800, nasdaq: 18500, eurUsd: 1.08, usdJpy: 152,
      creditHyOasBps: 320, creditIgOasBps: 95,
      recentNews: [], upcomingEvents: [],
    };

    if (!eodhKey || eodhKey === 'demo') return fallback;

    const fetchNum = async (ticker: string): Promise<number | null> => {
      const tStart = Date.now();
      this.realtimePrice.recordEodhdCall();
      try {
        const url = `https://eodhd.com/api/real-time/${encodeURIComponent(ticker)}?api_token=${eodhKey}&fmt=json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const latencyMs = Date.now() - tStart;
        if (!res.ok) {
          this.logEodhdCall({ ticker, eodhdTicker: ticker, source: 'eodhd', success: false, statusCode: res.status, latencyMs, calledBy: 'market_snapshot', errorMessage: `HTTP_${res.status}` });
          return null;
        }
        const d = await res.json() as Record<string, unknown>;
        const v = Number(d['close'] ?? d['previousClose'] ?? d['open'] ?? d['last']);
        const ok = isFinite(v) && v > 0;
        if (ok) {
          this.logEodhdCall({ ticker, eodhdTicker: ticker, source: 'eodhd', success: true, statusCode: res.status, latencyMs, priceUsd: v, calledBy: 'market_snapshot' });
        } else {
          this.logEodhdCall({ ticker, eodhdTicker: ticker, source: 'eodhd', success: false, statusCode: res.status, latencyMs, calledBy: 'market_snapshot', errorMessage: 'empty_price_field' });
        }
        return ok ? v : null;
      } catch (e) {
        this.logEodhdCall({ ticker, eodhdTicker: ticker, source: 'eodhd', success: false, latencyMs: Date.now() - tStart, calledBy: 'market_snapshot', errorMessage: String(e).slice(0, 200) });
        return null;
      }
    };

    const [
      vix, dxy, us10y, us2y, brent, btc, eth, gold, spy, qqq, eurusd, usdjpy,
      // Extensions macro : sectoriels + crypto alt + FX EM + bonds
      silver, copper, uranium, natgas, solana, xrp, tlt, hyg, iwm, eem,
    ] =
      await Promise.all([
        fetchNum('^VIX.INDX'),
        fetchNum('DX-Y.NYB.FOREX'),
        fetchNum('US10Y.BOND'),
        fetchNum('US2Y.BOND'),
        fetchNum('BZ.COMM'),
        fetchNum('BTC-USD.CC'),
        fetchNum('ETH-USD.CC'),
        fetchNum('GC.COMM'),
        fetchNum('SPY.US'),
        fetchNum('QQQ.US'),
        fetchNum('EURUSD.FOREX'),
        fetchNum('USDJPY.FOREX'),
        fetchNum('SI.COMM'),          // Silver
        fetchNum('HG.COMM'),          // Copper
        fetchNum('URA.US'),           // Uranium ETF
        fetchNum('NG.COMM'),          // Natural gas
        fetchNum('SOL-USD.CC'),       // Solana
        fetchNum('XRP-USD.CC'),       // XRP
        fetchNum('TLT.US'),           // US long bonds 20y
        fetchNum('HYG.US'),           // High yield corporate bonds
        fetchNum('IWM.US'),           // Russell 2000 (small caps)
        fetchNum('EEM.US'),           // Emerging markets
      ]);
    // Les nouveaux tickers ne sont pas dans le type MarketSnapshot pour l'instant
    // — ils seront poussés dans recentNews / additionalContext si besoin plus tard.
    // Conservés ici pour alimenter le cache EODHD et le log pour analyse quota.
    void silver; void copper; void uranium; void natgas; void solana;
    void xrp; void tlt; void hyg; void iwm; void eem;

    // SPY ≈ SP500/10, QQQ ≈ NASDAQ/40
    return {
      timestamp: new Date().toISOString(),
      vix: vix ?? fallback.vix,
      usdDxy: dxy ?? fallback.usdDxy,
      us10yYield: us10y ?? fallback.us10yYield,
      us2yYield: us2y ?? fallback.us2yYield,
      brentUsd: brent ?? fallback.brentUsd,
      btcUsd: btc ?? fallback.btcUsd,
      ethUsd: eth ?? fallback.ethUsd,
      goldUsd: gold ?? fallback.goldUsd,
      sp500: spy ? spy * 10 : fallback.sp500,
      nasdaq: qqq ? qqq * 40 : fallback.nasdaq,
      eurUsd: eurusd ?? fallback.eurUsd,
      usdJpy: usdjpy ?? fallback.usdJpy,
      creditHyOasBps: fallback.creditHyOasBps,
      creditIgOasBps: fallback.creditIgOasBps,
      recentNews: [],
      upcomingEvents: [],
    };
  }

  /**
   * Calcule les métriques historiques du portefeuille sur 7-30 j pour le
   * bloc # MISSION injecté dans le prompt Claude (v2 : portfolio trajectory
   * optimizer). Fail-safe : toute métrique indisponible est null, Lisa sait
   * alors "historique insuffisant" plutôt que de voir un 0 trompeur.
   */
  private async computeHistoryMetrics(portfolioId: string): Promise<HistoryMetrics> {
    const client = this.supabase.getClient();
    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 86_400_000;
    const sevenDaysAgo = new Date(now - SEVEN_DAYS_MS).toISOString();
    const thirtyDaysAgo = new Date(now - 30 * 86_400_000).toISOString();

    // 1. Snapshots 30 j — returns + volatility + drawdown
    const { data: snapshots } = await client
      .from('lisa_portfolio_snapshots')
      .select('timestamp, total_value_usd, return_from_inception_pct, drawdown_from_peak_pct')
      .eq('portfolio_id', portfolioId)
      .gte('timestamp', thirtyDaysAgo)
      .order('timestamp', { ascending: true });

    let netReturnFromInceptionPct: number | null = null;
    let netReturn7dPct: number | null = null;
    let netReturn30dPct: number | null = null;
    let drawdownFromPeakPct: number | null = null;
    let realizedVolatility7dPct: number | null = null;

    if (snapshots && snapshots.length > 0) {
      const latest = snapshots[snapshots.length - 1];
      netReturnFromInceptionPct = Number(latest.return_from_inception_pct);
      drawdownFromPeakPct = Number(latest.drawdown_from_peak_pct);

      const sevenCutoff = now - SEVEN_DAYS_MS;
      const oldestIn7d = snapshots.find((s) => new Date(s.timestamp as string).getTime() >= sevenCutoff);
      if (oldestIn7d) {
        const pStart = Number(oldestIn7d.total_value_usd);
        const pEnd = Number(latest.total_value_usd);
        if (pStart > 0) netReturn7dPct = ((pEnd - pStart) / pStart) * 100;
      }
      const oldest30 = snapshots[0];
      const p30 = Number(oldest30.total_value_usd);
      if (p30 > 0) {
        netReturn30dPct = ((Number(latest.total_value_usd) - p30) / p30) * 100;
      }

      // Volatilité : écart-type des returns quotidiens sur 7 j
      // On garde le dernier snapshot de chaque jour (YYYY-MM-DD) pour lisser
      // les échantillons multiples dans la même journée.
      const byDay = new Map<string, number>();
      for (const s of snapshots) {
        const dayKey = String(s.timestamp).slice(0, 10);
        byDay.set(dayKey, Number(s.total_value_usd));
      }
      const dailyValues = Array.from(byDay.entries()).sort().slice(-8); // 8 jours = 7 returns
      if (dailyValues.length >= 3) {
        const returns: number[] = [];
        for (let i = 1; i < dailyValues.length; i++) {
          const prev = dailyValues[i - 1][1];
          const cur = dailyValues[i][1];
          if (prev > 0) returns.push(((cur - prev) / prev) * 100);
        }
        if (returns.length >= 2) {
          const mean = returns.reduce((sum, x) => sum + x, 0) / returns.length;
          const variance = returns.reduce((sum, x) => sum + (x - mean) ** 2, 0) / returns.length;
          realizedVolatility7dPct = Math.sqrt(variance);
        }
      }
    }

    // 2. Positions fermées — win rate + streak + frictions 7 j
    const { data: closedPositions } = await client
      .from('lisa_positions')
      .select('realized_pnl_usd, exit_timestamp, estimated_entry_cost_usd')
      .eq('portfolio_id', portfolioId)
      .neq('status', 'open')
      .order('exit_timestamp', { ascending: false })
      .limit(200);

    let winRatePct: number | null = null;
    let closedPositionsCount = 0;
    let recentStreak: RecentStreak = null;
    let tradingFrictionsUsd = 0;

    if (closedPositions && closedPositions.length > 0) {
      closedPositionsCount = closedPositions.length;
      const wins = closedPositions.filter((p) => Number(p.realized_pnl_usd ?? 0) > 0).length;
      winRatePct = (wins / closedPositionsCount) * 100;

      const firstPnl = Number(closedPositions[0].realized_pnl_usd ?? 0);
      if (firstPnl !== 0) {
        const isWin = firstPnl > 0;
        let count = 0;
        for (const p of closedPositions) {
          const pnl = Number(p.realized_pnl_usd ?? 0);
          if (pnl === 0) break;
          if ((pnl > 0) === isWin) count++;
          else break;
        }
        recentStreak = { kind: isWin ? 'wins' : 'losses', count };
      }

      tradingFrictionsUsd = closedPositions
        .filter((p) => p.exit_timestamp && new Date(p.exit_timestamp as string).getTime() >= now - SEVEN_DAYS_MS)
        .reduce((sum, p) => sum + Number(p.estimated_entry_cost_usd ?? 0), 0);
    }

    // 3. Coûts Claude 7 j
    const { data: recentProposals } = await client
      .from('lisa_proposals')
      .select('claude_cost_usd')
      .eq('portfolio_id', portfolioId)
      .gte('generated_at', sevenDaysAgo);
    const claudeUsd = (recentProposals ?? []).reduce(
      (sum, p) => sum + Number(p.claude_cost_usd ?? 0),
      0,
    );

    // 4. Coûts EODHD 7 j — plan All-In-One est à tarif fixe, donc on
    // approxime via un marginal cost par call ($0.0001/call = $1 pour 10k
    // appels). C'est une indication d'échelle pour Lisa, pas une facture.
    const { count: eodhdCount } = await client
      .from('eodhd_request_log')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .eq('source', 'eodhd')
      .gte('timestamp', sevenDaysAgo);
    const eodhdUsd = (eodhdCount ?? 0) * 0.0001;

    const totalCost7d = claudeUsd + eodhdUsd + tradingFrictionsUsd;
    const avgDailyCostUsd7d = totalCost7d > 0 ? totalCost7d / 7 : null;

    // 5. Dernier cycle mécanique — briefing pour Lisa
    const { data: lastCycleSummary } = await client
      .from('lisa_mechanical_cycle_summary')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .order('cycle_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let lastMechanicalCycle: import('@smartvest/ai-analyst').MechanicalCycleSummary | null = null;
    if (lastCycleSummary) {
      lastMechanicalCycle = {
        cycleAt: lastCycleSummary.cycle_at as string,
        directiveId: (lastCycleSummary.directive_id as string | null) ?? null,
        directiveAgeMinutes: (lastCycleSummary.directive_age_minutes as number | null) ?? null,
        opensCount: (lastCycleSummary.opens_count as number) ?? 0,
        closesStopCount: (lastCycleSummary.closes_stop_count as number) ?? 0,
        closesTargetCount: (lastCycleSummary.closes_target_count as number) ?? 0,
        closesInvalidatedCount: (lastCycleSummary.closes_invalidated_count as number) ?? 0,
        netPnlSinceProposalUsd: Number(lastCycleSummary.net_pnl_since_proposal_usd ?? 0),
        grossWinsUsd: Number(lastCycleSummary.gross_wins_usd ?? 0),
        grossLossesUsd: Number(lastCycleSummary.gross_losses_usd ?? 0),
        winRatePct: lastCycleSummary.win_rate_pct != null ? Number(lastCycleSummary.win_rate_pct) : null,
        avgHoldMinutes: lastCycleSummary.avg_hold_minutes != null ? Number(lastCycleSummary.avg_hold_minutes) : null,
        largestWinPct: lastCycleSummary.largest_win_pct != null ? Number(lastCycleSummary.largest_win_pct) : null,
        largestLossPct: lastCycleSummary.largest_loss_pct != null ? Number(lastCycleSummary.largest_loss_pct) : null,
        stopsClusterFlag: (lastCycleSummary.stops_cluster_flag as boolean) ?? false,
        stopsClusterWindowMinutes: (lastCycleSummary.stops_cluster_window_minutes as number | null) ?? null,
        exposurePct: lastCycleSummary.exposure_pct != null ? Number(lastCycleSummary.exposure_pct) : null,
        cashUsd: lastCycleSummary.cash_usd != null ? Number(lastCycleSummary.cash_usd) : null,
        openPositionsCount: (lastCycleSummary.open_positions_count as number) ?? 0,
        drawdownSinceDirectivePct: lastCycleSummary.drawdown_since_directive_pct != null ? Number(lastCycleSummary.drawdown_since_directive_pct) : null,
        vixLevel: lastCycleSummary.vix_level != null ? Number(lastCycleSummary.vix_level) : null,
        dxyLevel: lastCycleSummary.dxy_level != null ? Number(lastCycleSummary.dxy_level) : null,
      };
    }

    return {
      netReturnFromInceptionPct,
      netReturn7dPct,
      netReturn30dPct,
      drawdownFromPeakPct,
      realizedVolatility7dPct,
      winRatePct,
      closedPositionsCount,
      recentStreak,
      avgDailyCostUsd7d,
      costBreakdown: {
        claudeUsd,
        eodhdUsd,
        tradingFrictionsUsd,
      },
      lastMechanicalCycle,
    };
  }

  async getAgentStatus(_userId: string, portfolioId: string) {
    const client = this.supabase.getClient();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const [directiveRes, cyclesRes, actionsRes, wakeupsRes] = await Promise.all([
      // Directive active
      client
        .from('lisa_mechanical_directives')
        .select('generated_at, valid_until, market_momentum, trajectory_status, risk_posture, target_symbols, favored_asset_classes, avoided_asset_classes, tactical_overrides')
        .eq('portfolio_id', portfolioId)
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

      // Derniers cycles mécaniques
      client
        .from('lisa_mechanical_cycle_summary')
        .select('cycle_at, directive_age_minutes, opens_count, closes_stop_count, closes_target_count, closes_invalidated_count, net_pnl_since_proposal_usd, win_rate_pct, avg_hold_minutes, largest_win_pct, largest_loss_pct, stops_cluster_flag, exposure_pct, cash_usd, open_positions_count, drawdown_since_directive_pct, vix_level, dxy_level')
        .eq('portfolio_id', portfolioId)
        .order('cycle_at', { ascending: false })
        .limit(20),

      // Actions récentes de l'agent dans le decision log
      client
        .from('lisa_decision_log')
        .select('timestamp, kind, summary, payload')
        .eq('portfolio_id', portfolioId)
        .in('kind', ['autopilot_cycle_completed', 'autopilot_cycle_started', 'position_opened', 'position_closed'])
        .order('timestamp', { ascending: false })
        .limit(30),

      // P5.5 — Wake-ups agent → Lisa du jour (pour affichage UI dashboard)
      client
        .from('lisa_decision_log')
        .select('timestamp, summary, payload')
        .eq('portfolio_id', portfolioId)
        .eq('kind', 'agent_wake_up_triggered')
        .gte('timestamp', todayStart.toISOString())
        .order('timestamp', { ascending: false })
        .limit(20),
    ]);

    return {
      directive: directiveRes.data ?? null,
      cycles: cyclesRes.data ?? [],
      recentActions: actionsRes.data ?? [],
      // P5.5 — Wake-ups agent → Lisa (dashboard UI)
      agentWakeUps: {
        today: wakeupsRes.data ?? [],
        countToday: wakeupsRes.data?.length ?? 0,
        dailyBudget: 8,
      },
    };
  }

  /**
   * Dérive le statut d'avancement vs la trajectoire cible sur l'horizon
   * configuré. Utilise netReturn dans la fenêtre 7j (proxy) comparée à
   * la cible extrapolée depuis return_target_daily_pct ou _monthly_pct.
   */
  private computeTrajectoryStatus(
    objectives: PerformanceObjectives,
    metrics: HistoryMetrics,
  ): { status: TrajectoryStatus | null; targetExtrapolatedPct: number | null } {
    // Priorité : daily > monthly > annual pour extrapoler sur 7 j
    let targetPerDay: number | null = null;
    if (objectives.returnTargetDailyPct !== null) {
      targetPerDay = objectives.returnTargetDailyPct;
    } else if (objectives.returnTargetMonthlyPct !== null) {
      targetPerDay = objectives.returnTargetMonthlyPct / 30;
    } else if (objectives.returnTargetAnnualPct !== null) {
      targetPerDay = objectives.returnTargetAnnualPct / 365;
    }

    if (targetPerDay === null || metrics.netReturn7dPct === null) {
      return { status: null, targetExtrapolatedPct: null };
    }

    const targetExtrapolatedPct = targetPerDay * 7;
    const realised = metrics.netReturn7dPct;

    // Règle HORS_TRAJECTOIRE : return négatif OU coûts > 50% gains
    const bruteGain = realised; // proxy — 7d return net suffit ici
    const costShare =
      metrics.avgDailyCostUsd7d !== null && bruteGain > 0
        ? (metrics.avgDailyCostUsd7d * 7) / ((bruteGain / 100) * 10_000) // % de gains réalisés absorbés par coûts (10k capital ref)
        : 0;

    let status: TrajectoryStatus;
    if (realised < 0 || costShare > 0.5) {
      status = 'HORS_TRAJECTOIRE';
    } else if (realised >= targetExtrapolatedPct * 1.1) {
      status = 'EN_AVANCE';
    } else if (realised >= targetExtrapolatedPct * 0.8) {
      status = 'DANS_LE_PLAN';
    } else {
      status = 'EN_RETARD';
    }

    return { status, targetExtrapolatedPct };
  }

  private async logDecision(
    portfolioId: string,
    kind: string,
    entry: { summary: string; rationale: string; payload: Record<string, unknown>; triggeredBy: string },
  ): Promise<void> {
    try {
      await this.decisionLog.append({
        portfolioId,
        kind,
        summary: entry.summary,
        rationale: entry.rationale,
        payload: entry.payload,
        triggeredBy: entry.triggeredBy as 'user_manual' | 'autopilot_cron' | 'risk_monitor' | 'corpus_trigger' | 'market_event',
      });
    } catch (e) {
      this.logger.warn(`Decision log append failed: ${String(e)}`);
    }
  }

  // Helper exposé pour le log d'une petite valeur numérique
  private roundDecimal(v: string | number, precision = 2): string {
    return new Decimal(v).toFixed(precision);
  }

  /**
   * Récupère le solde du compte Binance externe de l'utilisateur via l'API
   * privée signed (/api/v3/account). Lecture seule — ne peut rien trader.
   *
   * Retourne une vue enrichie : par asset, solde libre + bloqué, prix USD
   * courant, valeur totale en USD. Les stablecoins valent 1$ par défaut.
   *
   * Si BINANCE_API_KEY n'est pas configuré → retourne configured: false.
   */
  async fetchBinanceBalance(): Promise<{
    configured: boolean;
    balances: Array<{ asset: string; free: string; locked: string; total: string; usdPrice: string; usdValue: string }>;
    totalUsd: string;
    lastSyncAt: string | null;
    error?: string;
  }> {
    const apiKey = this.config.get<string>('BINANCE_API_KEY') ?? this.config.get<string>('smartvest-lisa');
    const secretKey = this.config.get<string>('BINANCE_SECRET_KEY');

    if (!apiKey || !secretKey) {
      return { configured: false, balances: [], totalUsd: '0.00', lastSyncAt: null };
    }

    try {
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}&recvWindow=5000`;
      const signature = createHmac('sha256', secretKey).update(queryString).digest('hex');
      const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;

      const res = await fetch(url, {
        headers: { 'X-MBX-APIKEY': apiKey },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          configured: true,
          balances: [],
          totalUsd: '0.00',
          lastSyncAt: null,
          error: `Binance API ${res.status}: ${body.slice(0, 200)}`,
        };
      }

      const data = await res.json() as {
        balances: Array<{ asset: string; free: string; locked: string }>;
        updateTime: number;
      };

      const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDP']);

      const nonZero = data.balances
        .map((b) => ({
          asset: b.asset,
          free: new Decimal(b.free),
          locked: new Decimal(b.locked),
          total: new Decimal(b.free).plus(b.locked),
        }))
        .filter((b) => b.total.gt(0));

      const enriched = await Promise.all(nonZero.map(async (b) => {
        let usdPrice = new Decimal(0);
        if (STABLECOINS.has(b.asset)) {
          usdPrice = new Decimal(1);
        } else {
          try {
            const quote = await this.fetchLivePrice(b.asset);
            usdPrice = new Decimal(quote.price);
          } catch {
            usdPrice = new Decimal(0);
          }
        }
        return {
          asset: b.asset,
          free: b.free.toFixed(8),
          locked: b.locked.toFixed(8),
          total: b.total.toFixed(8),
          usdPrice: usdPrice.toFixed(8),
          usdValue: b.total.mul(usdPrice).toFixed(2),
        };
      }));

      enriched.sort((a, b) => new Decimal(b.usdValue).minus(a.usdValue).toNumber());

      const totalUsd = enriched.reduce((s, b) => s.plus(b.usdValue), new Decimal(0));

      return {
        configured: true,
        balances: enriched,
        totalUsd: totalUsd.toFixed(2),
        lastSyncAt: new Date(data.updateTime).toISOString(),
      };
    } catch (e) {
      this.logger.warn(`Binance balance fetch failed: ${String(e)}`);
      return {
        configured: true,
        balances: [],
        totalUsd: '0.00',
        lastSyncAt: null,
        error: String(e).slice(0, 200),
      };
    }
  }

  /** Borne de temps : début du jour courant en UTC (00:00 UTC). */
  private startOfTodayUtc(): string {
    const now = new Date();
    return new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      0, 0, 0, 0,
    )).toISOString();
  }

  /** Borne de temps : début du mois calendaire courant en UTC. */
  private startOfMonthUtc(): string {
    const now = new Date();
    return new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), 1,
      0, 0, 0, 0,
    )).toISOString();
  }

  /** Cache du taux USD→EUR récupéré dynamiquement depuis Frankfurter (BCE). */
  private cachedUsdEurRate: number | null = null;
  private cachedUsdEurRateAsOf = 0;

  /**
   * Taux de change USD→EUR en live depuis l'API Frankfurter (source BCE).
   * Mise à jour toutes les 24h, cache en mémoire. En cas d'échec : env var
   * USD_EUR_RATE, sinon 0.855 en dernier recours.
   *
   * Frankfurter publie les taux de référence BCE mis à jour chaque jour
   * ouvré vers 16h CET. API gratuite, pas de clé, pas de quota.
   */
  private async usdToEurRate(): Promise<number> {
    const CACHE_MS = 24 * 60 * 60 * 1000;
    if (this.cachedUsdEurRate && Date.now() - this.cachedUsdEurRateAsOf < CACHE_MS) {
      return this.cachedUsdEurRate;
    }
    try {
      const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR', {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json() as { rates?: { EUR?: number } };
        const rate = data.rates?.EUR;
        if (typeof rate === 'number' && rate > 0.5 && rate < 2) {
          this.cachedUsdEurRate = rate;
          this.cachedUsdEurRateAsOf = Date.now();
          return rate;
        }
      }
    } catch {
      // fall through to fallback
    }
    // Fallback : env var ou défaut
    const raw = this.config.get<string>('USD_EUR_RATE');
    const parsed = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.855;
  }

  /**
   * Statistiques EODHD agrégées depuis eodhd_request_log.
   * Fenêtres CALENDAIRES UTC : "today" = depuis 00:00 UTC, "thisMonth" = depuis
   * le 1er du mois 00:00 UTC. Aligné avec le reset réel d'EODHD.
   */
  async fetchEodhdStats(): Promise<{
    today: { total: number; success: number; failures: number; fallbacks: number; avgLatencyMs: number };
    thisMonth: { calls: number; subscriptionUsd: number; subscriptionEur: number };
    all: { total: number; success: number };
    lastCallAsOf: string | null;
    usdEurRate: number;
  }> {
    const client = this.supabase.getClient();
    const startOfToday = this.startOfTodayUtc();
    const startOfMonth = this.startOfMonthUtc();

    const [rowsToday, rowsMonth, allCount, allSuccessCount, lastCall] = await Promise.all([
      client
        .from('eodhd_request_log')
        .select('source, success, latency_ms')
        .gte('timestamp', startOfToday),
      client
        .from('eodhd_request_log')
        .select('source', { count: 'exact', head: true })
        .gte('timestamp', startOfMonth)
        .eq('source', 'eodhd'),
      client
        .from('eodhd_request_log')
        .select('*', { count: 'exact', head: true }),
      client
        .from('eodhd_request_log')
        .select('*', { count: 'exact', head: true })
        .eq('success', true),
      client
        .from('eodhd_request_log')
        .select('timestamp')
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const rows = (rowsToday.data ?? []) as Array<{ source: string; success: boolean; latency_ms: number | null }>;
    const eodhdRows = rows.filter((r) => r.source === 'eodhd');
    const latencies = eodhdRows.map((r) => r.latency_ms).filter((n): n is number => typeof n === 'number' && n > 0);

    // Abonnement EODHD (fixe mensuel, payé peu importe le nb d'appels).
    // Configurable via env var EODHD_MONTHLY_COST_USD, défaut 99.99 (plan
    // All-In-One avec quota 100k appels/jour).
    const subRaw = this.config.get<string>('EODHD_MONTHLY_COST_USD');
    const subscriptionUsd = subRaw && !isNaN(parseFloat(subRaw)) ? parseFloat(subRaw) : 99.99;
    const rate = await this.usdToEurRate();

    return {
      today: {
        total: eodhdRows.length,
        success: eodhdRows.filter((r) => r.success).length,
        failures: eodhdRows.filter((r) => !r.success).length,
        fallbacks: rows.filter((r) => r.source !== 'eodhd').length,
        avgLatencyMs: latencies.length > 0
          ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length)
          : 0,
      },
      thisMonth: {
        calls: rowsMonth.count ?? 0,
        subscriptionUsd,
        subscriptionEur: subscriptionUsd * rate,
      },
      all: {
        total: allCount.count ?? 0,
        success: allSuccessCount.count ?? 0,
      },
      lastCallAsOf: (lastCall.data?.timestamp as string | undefined) ?? null,
      usdEurRate: rate,
    };
  }

  /**
   * Statistiques Claude agrégées depuis lisa_proposals.
   * Fenêtres CALENDAIRES UTC identiques à fetchEodhdStats.
   */
  async fetchClaudeStats(): Promise<{
    today: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; costEur: number };
    thisMonth: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; costEur: number };
    all: { requests: number; costUsd: number; costEur: number };
    usdEurRate: number;
  }> {
    const client = this.supabase.getClient();
    const startOfToday = this.startOfTodayUtc();
    const startOfMonth = this.startOfMonthUtc();
    const rate = await this.usdToEurRate();

    const [today, month, all] = await Promise.all([
      client
        .from('lisa_proposals')
        .select('claude_input_tokens, claude_output_tokens, claude_cost_usd')
        .gte('generated_at', startOfToday),
      client
        .from('lisa_proposals')
        .select('claude_input_tokens, claude_output_tokens, claude_cost_usd')
        .gte('generated_at', startOfMonth),
      client
        .from('lisa_proposals')
        .select('claude_input_tokens, claude_output_tokens, claude_cost_usd'),
    ]);

    const agg = (rows: Array<{ claude_input_tokens: number | null; claude_output_tokens: number | null; claude_cost_usd: number | null }> | null) => {
      const list = rows ?? [];
      const inputTokens = list.reduce((s, r) => s + (Number(r.claude_input_tokens) || 0), 0);
      const outputTokens = list.reduce((s, r) => s + (Number(r.claude_output_tokens) || 0), 0);
      const costUsd = list.reduce((s, r) => s + (Number(r.claude_cost_usd) || 0), 0);
      return {
        requests: list.length,
        inputTokens,
        outputTokens,
        costUsd,
        costEur: costUsd * rate,
      };
    };

    const allStats = agg(all.data as never);
    return {
      today: agg(today.data as never),
      thisMonth: agg(month.data as never),
      all: { requests: allStats.requests, costUsd: allStats.costUsd, costEur: allStats.costEur },
      usdEurRate: rate,
    };
  }
}
