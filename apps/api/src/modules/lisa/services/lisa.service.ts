import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import {
  CorpusQueryService,
  LisaClaudeClient,
  PaperBrokerService,
  RiskEnforcer,
  RiskMonitorService,
  ThesisGeneratorService,
  type AllocationProposal,
  type LisaSessionConfig,
  type MarketSnapshot,
  type PaperPosition,
  type PortfolioSnapshot,
  type SessionProfile,
} from '@smartvest/ai-analyst';
import { BinanceAdapter } from '@smartvest/brokers';
import { SupabaseService } from '../../supabase/supabase.service';

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

  async upsertSessionConfig(userId: string, portfolioId: string, config: Partial<LisaSessionConfig>) {
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

    const { data, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .upsert({
        user_id: userId,
        portfolio_id: portfolioId,
        profile: config.profile ?? 'long_term_investor',
        capital_usd: config.capitalUsd ?? '10000',
        base_currency: config.baseCurrency ?? 'EUR',
        risk_constraints: config.riskConstraints ?? {},
        include_asset_classes: config.includeAssetClasses ?? null,
        exclude_asset_classes: config.excludeAssetClasses ?? null,
        anti_consensus_strength: config.antiConsensusStrength ?? 7,
        max_theses: config.maxTheses ?? 5,
        enable_crypto: config.enableCrypto ?? true,
        enable_derivatives: config.enableDerivatives ?? false,
        enable_leverage: config.enableLeverage ?? false,
      }, { onConflict: 'portfolio_id' })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  // ── Proposal generation ────────────────────────────────────────────────────

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
      riskConstraints: (config.risk_constraints as LisaSessionConfig['riskConstraints']) ?? {
        maxDrawdown2DaysPct: 10,
        maxDrawdown7DaysPct: 15,
        maxDrawdown30DaysPct: 25,
        maxPositionSizePct: 25,
        maxOpenPositions: 10,
        maxLeverage: 1.5,
        maxExposurePerAssetClassPct: 40,
        maxPortfolioVolatilityPct: 20,
        autoLiquidateOnKill: true,
      },
      antiConsensusStrength: (config.anti_consensus_strength as number) ?? 7,
      maxTheses: (config.max_theses as number) ?? 5,
      enableCrypto: (config.enable_crypto as boolean) ?? true,
      enableDerivatives: (config.enable_derivatives as boolean) ?? false,
      enableLeverage: (config.enable_leverage as boolean) ?? false,
    };

    const marketSnapshot = await this.fetchMarketSnapshot();

    const result = await this.thesisGenerator.generateTheses({
      config: sessionConfig,
      marketSnapshot,
      ...(userFocus !== undefined ? { userFocus } : {}),
      includeFullCorpus: true,
    });

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
      claude_cost_usd: result.costUsd,
      generated_at: finalProposal.generatedAt,
      expires_at: new Date(Date.now() + 3600_000).toISOString(), // 1h validity
    });

    // Decision log
    await this.logDecision(portfolioId, 'proposal_generated', {
      summary: `Lisa generated ${finalProposal.theses.length} theses, regime=${finalProposal.detectedRegime}`,
      rationale: finalProposal.regimeSummary,
      payload: { proposalId: finalProposal.id, costUsd: result.costUsd },
      triggeredBy: 'user_manual',
    });

    return finalProposal;
  }

  async approveProposal(userId: string, proposalId: string): Promise<{ openedPositions: PaperPosition[] }> {
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

    const theses = proposal.theses as Array<Record<string, unknown>>;
    const allocations = proposal.allocations as Array<{ thesisId: string; pctCapital: number; amountUsd: string }>;

    const opened: PaperPosition[] = [];

    for (const alloc of allocations) {
      const thesis = theses.find((t) => t.id === alloc.thesisId);
      if (!thesis) continue;

      const expressions = thesis.expressions as Array<Record<string, unknown>>;
      const preferredIdx = (thesis.preferredExpressionIndex as number) ?? 0;
      const expression = expressions[preferredIdx];
      if (!expression) continue;

      try {
        const quote = await this.fetchLivePrice(expression.symbol as string);
        const riskReward = thesis.riskReward as { horizonDays: number };
        const assetClass = String(expression.assetClass ?? '');
        const isCrypto = assetClass.startsWith('crypto_');

        // Route to Binance live execution if all conditions are met
        const binanceResult = isCrypto
          ? await this.tryBinanceExecution(expression.symbol as string, alloc.amountUsd, quote.price)
          : null;

        const pos = await this.paperBroker.openPosition({
          portfolioId: proposal.portfolio_id as string,
          proposalId,
          thesisId: alloc.thesisId,
          expressionIndex: preferredIdx,
          capitalAllocationUsd: alloc.amountUsd,
          livePrice: quote.price,
          stopLossPrice: null,
          takeProfitPrice: null,
          horizonDays: riskReward.horizonDays ?? 30,
        });
        opened.push(pos);

        await this.logDecision(proposal.portfolio_id as string, 'position_opened', {
          summary: `Opened ${expression.symbol}: ${alloc.pctCapital}% (${alloc.amountUsd} USD) at ${quote.price}`,
          rationale: String(thesis.summary),
          payload: {
            positionId: pos.id,
            thesisId: alloc.thesisId,
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

    return { openedPositions: opened };
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

  async getCurrentSnapshot(userId: string, portfolioId: string): Promise<PortfolioSnapshot> {
    await this.assertPortfolioOwner(userId, portfolioId);
    return this.paperBroker.computeSnapshot(portfolioId);
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
  private async fetchLivePrice(symbol: string): Promise<{ symbol: string; price: string; asOf: string; source: string }> {
    const eodhKey = this.config.get<string>('EODHD_API_KEY');
    const now = new Date().toISOString();

    // 1. Try EODHD real-time endpoint
    if (eodhKey && eodhKey !== 'demo') {
      try {
        const ticker = this.toEodhdTicker(symbol);
        const url = `https://eodhd.com/api/real-time/${encodeURIComponent(ticker)}?api_token=${eodhKey}&fmt=json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const data = await res.json() as Record<string, unknown>;
          const price = data['close'] ?? data['previousClose'] ?? data['open'];
          if (price && Number(price) > 0) {
            return { symbol, price: String(price), asOf: now, source: 'eodhd' };
          }
        }
      } catch (e) {
        this.logger.warn(`EODHD price fetch failed for ${symbol}: ${String(e)}`);
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
      return { symbol, price: String(quote.price), asOf: quote.as_of as string, source: 'supabase_quotes' };
    }

    // 3. Static fallback (simulation still works without live data)
    this.logger.warn(`No quote found for ${symbol}, returning fallback price`);
    return { symbol, price: this.getFallbackPrice(symbol), asOf: now, source: 'fallback' };
  }

  /**
   * Convert SmartVest/Binance symbol to EODHD ticker format.
   * BTC → BTC-USD.CC, BTCUSDT → BTC-USD.CC, AAPL → AAPL.US
   */
  private toEodhdTicker(symbol: string): string {
    const s = symbol.toUpperCase();
    const cryptoMap: Record<string, string> = {
      'BTC': 'BTC-USD.CC', 'BTCUSDT': 'BTC-USD.CC', 'BITCOIN': 'BTC-USD.CC',
      'ETH': 'ETH-USD.CC', 'ETHUSDT': 'ETH-USD.CC', 'ETHEREUM': 'ETH-USD.CC',
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
    // Already EODHD format (contains a dot)
    if (s.includes('.')) return s;
    // Default: US equity
    return `${s}.US`;
  }

  /** Approximate fallback prices (order-of-magnitude, simulation only) */
  private getFallbackPrice(symbol: string): string {
    const s = symbol.toUpperCase();
    const prices: Record<string, string> = {
      'BTC': '105000', 'BTCUSDT': '105000', 'ETH': '3500', 'ETHUSDT': '3500',
      'SOL': '180', 'BNB': '600', 'XRP': '2.5', 'ADA': '0.9',
      'GOLD': '3300', 'GC': '3300', 'SPY': '580', 'QQQ': '490',
      'AAPL': '210', 'MSFT': '420', 'NVDA': '900',
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
      try {
        const url = `https://eodhd.com/api/real-time/${encodeURIComponent(ticker)}?api_token=${eodhKey}&fmt=json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const d = await res.json() as Record<string, unknown>;
        const v = Number(d['close'] ?? d['previousClose'] ?? d['open'] ?? d['last']);
        return isFinite(v) && v > 0 ? v : null;
      } catch { return null; }
    };

    const [vix, dxy, us10y, us2y, brent, btc, eth, gold, spy, qqq, eurusd, usdjpy] =
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
      ]);

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

  private async logDecision(
    portfolioId: string,
    kind: string,
    entry: { summary: string; rationale: string; payload: Record<string, unknown>; triggeredBy: string },
  ): Promise<void> {
    const { error } = await this.supabase.getClient().from('lisa_decision_log').insert({
      portfolio_id: portfolioId,
      kind,
      summary: entry.summary,
      rationale: entry.rationale,
      payload: entry.payload,
      triggered_by: entry.triggeredBy,
      hash_chain_current: await this.computeHash(kind, entry.summary),
    });
    if (error) this.logger.warn(`Decision log insert failed: ${error.message}`);
  }

  private async computeHash(kind: string, summary: string): Promise<string> {
    // Simple hash pour MVP — à remplacer par chaîne cryptographique en P4.12
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(`${kind}|${summary}|${Date.now()}`).digest('hex').slice(0, 16);
  }

  // Helper exposé pour le log d'une petite valeur numérique
  private roundDecimal(v: string | number, precision = 2): string {
    return new Decimal(v).toFixed(precision);
  }
}
