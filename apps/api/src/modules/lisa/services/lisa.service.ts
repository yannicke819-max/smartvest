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

        const pos = await this.paperBroker.openPosition({
          portfolioId: proposal.portfolio_id as string,
          proposalId,
          thesisId: alloc.thesisId,
          expressionIndex: preferredIdx,
          capitalAllocationUsd: alloc.amountUsd,
          livePrice: quote.price,
          stopLossPrice: null,  // TODO: extract from thesis.invalidation
          takeProfitPrice: null,
          horizonDays: riskReward.horizonDays ?? 30,
        });
        opened.push(pos);

        await this.logDecision(proposal.portfolio_id as string, 'position_opened', {
          summary: `Opened ${expression.symbol}: ${alloc.pctCapital}% (${alloc.amountUsd} USD) at ${quote.price}`,
          rationale: String(thesis.summary),
          payload: { positionId: pos.id, thesisId: alloc.thesisId },
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
   * Fetch live price — pour l'instant mock EODHD-like. En production,
   * remplacer par l'intégration réelle du MarketDataService existant.
   */
  private async fetchLivePrice(symbol: string): Promise<{ symbol: string; price: string; asOf: string; source: string }> {
    // Tentative 1 : lookup dans quotes table Supabase
    const { data: quote } = await this.supabase.getClient()
      .from('quotes')
      .select('price, as_of')
      .ilike('asset_id', `%${symbol}%`)
      .order('as_of', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (quote) {
      return {
        symbol,
        price: String(quote.price),
        asOf: quote.as_of as string,
        source: 'supabase_quotes',
      };
    }

    // Fallback : retourner un prix par défaut (permet simulation fonctionnelle
    // même sans EODHD configuré). En prod, on irait fetch EODHD REST.
    this.logger.warn(`No quote found for ${symbol}, returning fallback price $100`);
    return {
      symbol,
      price: '100.00',
      asOf: new Date().toISOString(),
      source: 'fallback',
    };
  }

  /**
   * Assemble une MarketSnapshot pour passer à Lisa. Version minimaliste pour
   * démarrer — à enrichir avec EODHD news + economic calendar en P4.11.
   */
  private async fetchMarketSnapshot(): Promise<MarketSnapshot> {
    // TODO: fetch from EODHD + FRED + providers
    return {
      timestamp: new Date().toISOString(),
      vix: 18.5,
      usdDxy: 102.3,
      us10yYield: 4.2,
      us2yYield: 3.9,
      brentUsd: 78.0,
      btcUsd: 115000,
      ethUsd: 3800,
      goldUsd: 4200,
      sp500: 5800,
      nasdaq: 18500,
      eurUsd: 1.08,
      usdJpy: 152,
      creditHyOasBps: 320,
      creditIgOasBps: 95,
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
