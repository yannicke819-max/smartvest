/**
 * ThesisGeneratorService — Orchestre l'appel Claude pour produire
 * des thèses Lisa structurées à partir du contexte marché + corpus.
 *
 * Pipeline :
 *  1. Compose le user message (contexte marché live + corpus filtré +
 *     config session + demande spécifique)
 *  2. Appelle LisaClaudeClient avec le profile approprié
 *  3. Parse le JSON output de Claude
 *  4. Valide via Zod (LisaThesis + AllocationProposal schema)
 *  5. Retourne proposal structurée + metadata de coût
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LisaClaudeClient } from '../claude/client';
import type { CorpusQueryService } from '../corpus/corpus-query.service';
import type {
  AllocationProposal,
  LisaSessionConfig,
  LisaThesis,
  MarketRegime,
} from '../types';
import { LisaThesis as LisaThesisSchema, RiskConstraints } from '../types';

/**
 * Live market snapshot passé à Lisa à chaque cycle.
 * Format volontairement synthétique — Claude n'a pas besoin d'un dump complet
 * pour raisonner ; il a besoin des signaux clés.
 */
export interface MarketSnapshot {
  timestamp: string;
  vix: number;
  usdDxy: number;
  us10yYield: number;
  us2yYield: number;
  brentUsd: number;
  btcUsd: number;
  ethUsd: number;
  goldUsd: number;
  sp500: number;
  nasdaq: number;
  eurUsd: number;
  usdJpy: number;
  /** Spread HY OAS en bps */
  creditHyOasBps: number;
  creditIgOasBps: number;
  /** News / événements récents 24-72h */
  recentNews: Array<{
    headline: string;
    source: string;
    timestamp: string;
    relevance: 'high' | 'medium' | 'low';
  }>;
  /** Economic calendar 7 jours à venir */
  upcomingEvents: Array<{
    name: string;
    date: string;
    importance: 'high' | 'medium' | 'low';
  }>;
}

export interface GenerateThesesRequest {
  config: LisaSessionConfig;
  marketSnapshot: MarketSnapshot;
  /** Question / focus spécifique de l'utilisateur (optionnel) */
  userFocus?: string;
  /** Tags à matcher dans le corpus (auto-détectés si omis) */
  corpusTags?: string[];
  /** Include ALL corpus (25 events) dans le prompt ? (défaut false, seulement
   *  les analogs filtrés par tags) */
  includeFullCorpus?: boolean;
}

export interface GenerateThesesResponse {
  proposal: AllocationProposal;
  costUsd: number;
  cacheHitRatio: number | null;
  rawClaudeText: string;
  warnings: string[];
}

export class ThesisGeneratorService {
  constructor(
    private readonly claudeClient: LisaClaudeClient,
    private readonly corpus: CorpusQueryService,
  ) {}

  async generateTheses(req: GenerateThesesRequest): Promise<GenerateThesesResponse> {
    // 1. Fetch corpus relevant
    const corpusEvents = req.includeFullCorpus
      ? await this.corpus.fetchAll()
      : await this.corpus.fetchByTags(req.corpusTags ?? [], 10);

    const projected = corpusEvents.map((e) => this.corpus.projectForPrompt(e));
    const corpusBlock = this.corpus.serializeCorpusForPrompt(projected);

    // 2. Compose user message
    const userMessage = this.composeUserMessage(req, corpusBlock);

    // 3. Call Claude
    const claudeResult = await this.claudeClient.call({
      profile: req.config.profile,
      userMessage,
    });

    // 4. Parse JSON
    const parsed = this.extractAndParseJson(claudeResult.rawText);

    // 5. Validate + normalize into AllocationProposal
    const proposal = this.normalizeProposal(parsed, req.config, claudeResult);

    // 6. Compute metadata
    const costUsd = (this.claudeClient.constructor as typeof LisaClaudeClient)
      .estimateCostUsd(claudeResult.usage);

    const totalInput =
      (claudeResult.usage.inputTokens ?? 0) +
      (claudeResult.usage.cacheReadInputTokens ?? 0) +
      (claudeResult.usage.cacheCreationInputTokens ?? 0);
    const cacheHitRatio = totalInput > 0
      ? (claudeResult.usage.cacheReadInputTokens ?? 0) / totalInput
      : null;

    return {
      proposal,
      costUsd,
      cacheHitRatio,
      rawClaudeText: claudeResult.rawText,
      warnings: proposal.warnings,
    };
  }

  private composeUserMessage(req: GenerateThesesRequest, corpusBlock: string): string {
    const m = req.marketSnapshot;
    const config = req.config;

    const recentNewsBlock = m.recentNews
      .slice(0, 10)
      .map((n) => `- [${n.timestamp}] (${n.source}, ${n.relevance}) ${n.headline}`)
      .join('\n');

    const upcomingEventsBlock = m.upcomingEvents
      .slice(0, 10)
      .map((e) => `- ${e.date}: ${e.name} (${e.importance})`)
      .join('\n');

    const constraints = config.riskConstraints;

    return `
# LIVE MARKET CONTEXT
Timestamp: ${m.timestamp}

## Macro snapshot
- VIX: ${m.vix}
- DXY: ${m.usdDxy}
- US 10y yield: ${m.us10yYield}%
- US 2y yield: ${m.us2yYield}%
- US 2s10s: ${(m.us10yYield - m.us2yYield).toFixed(2)}bps
- Credit IG OAS: ${m.creditIgOasBps}bps
- Credit HY OAS: ${m.creditHyOasBps}bps
- Brent: $${m.brentUsd}
- Gold: $${m.goldUsd}
- BTC: $${m.btcUsd}
- ETH: $${m.ethUsd}
- EUR/USD: ${m.eurUsd}
- USD/JPY: ${m.usdJpy}
- S&P 500: ${m.sp500}
- Nasdaq: ${m.nasdaq}

## Recent news (24-72h)
${recentNewsBlock || '- (no recent news provided)'}

## Upcoming events (7 days)
${upcomingEventsBlock || '- (no upcoming events provided)'}

# HISTORICAL CORPUS (analogs à disposition)
${corpusBlock || '(no corpus events loaded for this query)'}

# SESSION CONFIG
- Profile: ${config.profile}
- Capital available: ${config.capitalUsd} ${config.baseCurrency}
- Anti-consensus strength: ${config.antiConsensusStrength}/10
- Max theses: ${config.maxTheses}
- Enable crypto: ${config.enableCrypto}
- Enable derivatives: ${config.enableDerivatives}
- Enable leverage: ${config.enableLeverage}

## Risk constraints (HARD LIMITS — respecter absolument)
- Max drawdown 2 days: ${constraints.maxDrawdown2DaysPct}% (AUTO KILL if breached)
- Max drawdown 7 days: ${constraints.maxDrawdown7DaysPct}%
- Max drawdown 30 days: ${constraints.maxDrawdown30DaysPct}%
- Max single position size: ${constraints.maxPositionSizePct}%
- Max open positions: ${constraints.maxOpenPositions}
- Max leverage: ${constraints.maxLeverage}x
- Max per asset class: ${constraints.maxExposurePerAssetClassPct}%
- Max portfolio volatility annualized: ${constraints.maxPortfolioVolatilityPct}%

## Target deployment (SOFT TARGET — vise ce niveau d'exposition)
- Déploiement cible : ${constraints.targetDeploymentPct ?? 60}% du capital
- Cash reserve cible : ${100 - (constraints.targetDeploymentPct ?? 60)}%
- IMPORTANT : la somme des allocations dans allocationSuggestion.perThesis
  doit approcher ${constraints.targetDeploymentPct ?? 60}% (± 10%), pas rester
  à 10%. Si tu ne trouves pas assez de setups de qualité pour déployer ce
  niveau, dis-le explicitement dans warnings et ramène cashReservePct en
  conséquence — mais ne mets pas par défaut 90% cash juste par prudence
  générique si l'utilisateur a demandé ${constraints.targetDeploymentPct ?? 60}% d'exposition.

${req.userFocus ? `\n# USER FOCUS\n${req.userFocus}\n` : ''}

# REQUEST
Applique TA méthode Lisa complète. Renvoie UNIQUEMENT le JSON au format
défini, sans markdown, sans explications hors JSON.
`.trim();
  }

  /**
   * Extrait le JSON d'un texte Claude (qui peut avoir du préambule ou
   * être entouré de fences ```json...```). Tolérant aux imperfections
   * fréquentes : trailing commas, commentaires //, fences mal placées.
   */
  private extractAndParseJson(text: string): unknown {
    // Strip markdown code fences if present
    let cleaned = text
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/\s*```\s*$/m, '')
      .trim();

    const tryParse = (s: string): unknown | null => {
      try { return JSON.parse(s); } catch { return null; }
    };

    // 1. Direct parse
    let parsed = tryParse(cleaned);
    if (parsed !== null) return parsed;

    // 2. Slice to first { ... last }
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    parsed = tryParse(cleaned);
    if (parsed !== null) return parsed;

    // 3. Strip single-line comments and /* ... */ blocks
    const stripComments = (s: string): string =>
      s.replace(/\/\/[^\n\r]*/g, '')
       .replace(/\/\*[\s\S]*?\*\//g, '');
    cleaned = stripComments(cleaned);
    parsed = tryParse(cleaned);
    if (parsed !== null) return parsed;

    // 4. Strip trailing commas before } or ]
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
    parsed = tryParse(cleaned);
    if (parsed !== null) return parsed;

    // 5. Last resort — detailed error with context around first failure
    try {
      JSON.parse(cleaned);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const match = msg.match(/position (\d+)/);
      if (match) {
        const pos = parseInt(match[1], 10);
        const start = Math.max(0, pos - 120);
        const end = Math.min(cleaned.length, pos + 120);
        const ctx = cleaned.slice(start, end).replace(/\n/g, '\\n');
        throw new Error(`JSON parse failed at pos ${pos}: ${msg}. Context: …${ctx}…`);
      }
      throw e;
    }
    throw new Error('Unreachable : JSON parse should have thrown before.');
  }

  /**
   * Normalise la réponse Claude brute en AllocationProposal typée.
   * Génère les UUIDs manquants, valide les enums, enforce les contraintes.
   */
  private normalizeProposal(
    parsed: unknown,
    config: LisaSessionConfig,
    claudeResult: { model: string; usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number } },
  ): AllocationProposal {
    const root = parsed as Record<string, unknown>;
    const now = new Date().toISOString();

    // Extract theses, ensure IDs are valid UUIDs, attach claude meta
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const thesesRaw = (root.theses as Array<Record<string, unknown>>) ?? [];
    const idMap = new Map<string, string>();
    for (const t of thesesRaw) {
      const origId = typeof t.id === 'string' ? t.id : '';
      if (!UUID_RE.test(origId)) {
        const newId = randomUUID();
        if (origId) idMap.set(origId, newId);
        t.id = newId;
      }
      // Normalize common assetClass aliases Claude invents despite the prompt
      const exprs = t.expressions as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(exprs)) {
        for (const e of exprs) {
          e.assetClass = this.normalizeAssetClass(e.assetClass, e.symbol);
        }
      }
    }
    // Also normalize pools scan asset classes
    for (const key of ['favored', 'avoided'] as const) {
      const pools = ((root.poolsScan as Record<string, unknown>)?.[key]) as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(pools)) {
        for (const p of pools) {
          p.assetClass = this.normalizeAssetClass(p.assetClass);
        }
      }
    }

    // Allocation suggestion (read before theses map so we can patch thesisId refs)
    const allocSug = (root.allocationSuggestion as Record<string, unknown>) ?? {};
    const perThesisRaw = (allocSug.perThesis as Array<Record<string, unknown>>) ?? [];
    for (const a of perThesisRaw) {
      const mapped = idMap.get(a.thesisId as string);
      if (mapped) a.thesisId = mapped;
    }

    const theses: LisaThesis[] = thesesRaw.map((t) => {
      const thesisId = t.id as string;
      const enriched = {
        ...t,
        id: thesisId,
        generatedAt: now,
        claudeMeta: {
          model: claudeResult.model,
          inputTokens: claudeResult.usage.inputTokens,
          outputTokens: claudeResult.usage.outputTokens,
          ...(claudeResult.usage.cacheReadInputTokens !== undefined
            ? { cachedTokens: claudeResult.usage.cacheReadInputTokens }
            : {}),
        },
      };

      // Validation stricte Zod
      try {
        return LisaThesisSchema.parse(enriched);
      } catch (e) {
        const issue = e instanceof z.ZodError
          ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ')
          : String(e);
        throw new Error(`Thesis validation failed for "${String(t.title)}": ${issue}`);
      }
    });

    const allocations = perThesisRaw.map((a) => ({
      thesisId: a.thesisId as string,
      pctCapital: a.pctCapital as number,
      amountUsd: a.amountUsd as string,
    }));
    const cashReservePct = (allocSug.cashReservePct as number) ?? 0;

    // Market context
    const mc = (root.marketContext as Record<string, unknown>) ?? {};
    const poolsScan = (root.poolsScan as Record<string, unknown>) ?? {};

    const proposal: AllocationProposal = {
      id: randomUUID(),
      capitalUsd: config.capitalUsd,
      baseCurrency: config.baseCurrency,
      detectedRegime: (mc.regime as MarketRegime) ?? 'fragmented_no_consensus',
      regimeSummary: (mc.regimeSummary as string) ?? '',
      favoredPockets: ((poolsScan.favored as Array<Record<string, unknown>>) ?? []).map((p) => ({
        assetClass: p.assetClass as AllocationProposal['favoredPockets'][number]['assetClass'],
        rationale: p.rationale as string,
      })),
      avoidedPockets: ((poolsScan.avoided as Array<Record<string, unknown>>) ?? []).map((p) => ({
        assetClass: p.assetClass as AllocationProposal['avoidedPockets'][number]['assetClass'],
        rationale: p.rationale as string,
      })),
      theses,
      allocations,
      cashReservePct,
      portfolioRiskLens: this.computeDefaultRiskLens(),
      constraints: RiskConstraints.parse(config.riskConstraints),
      warnings: (root.warnings as string[]) ?? [],
      generatedAt: now,
      status: 'draft' as const,
    };

    return proposal;
  }

  /**
   * Mappe les valeurs génériques / aliases que Claude invente parfois
   * (ex: "crypto", "equity") vers la bonne valeur granulaire de l'enum.
   * Si le symbol est connu (BTC/ETH), on l'utilise pour désambiguïser.
   */
  private normalizeAssetClass(value: unknown, symbol?: unknown): unknown {
    if (typeof value !== 'string') return value;
    const v = value.trim();
    // Déjà valide : on ne touche pas
    const VALID = new Set([
      'equity_us_large', 'equity_us_small', 'equity_eu', 'equity_em', 'equity_jp', 'equity_cn',
      'govt_bonds_us', 'govt_bonds_eu', 'govt_bonds_em',
      'credit_ig', 'credit_hy', 'credit_em', 'credit_private',
      'fx_g10', 'fx_em', 'fx_exotic',
      'commodities_energy', 'commodities_metals_precious', 'commodities_metals_industrial', 'commodities_agri',
      'crypto_bitcoin', 'crypto_ethereum', 'crypto_altcoins', 'crypto_stablecoin',
      'derivatives_options', 'derivatives_futures', 'derivatives_swaps', 'derivatives_vol',
      'structured_products', 'real_estate', 'alt_hedge_funds', 'cash',
    ]);
    if (VALID.has(v)) return v;

    const sym = typeof symbol === 'string' ? symbol.toUpperCase() : '';
    const lv = v.toLowerCase();

    // Crypto génériques — désambiguïser via le symbol si possible
    if (lv === 'crypto' || lv === 'cryptocurrency') {
      if (sym.includes('BTC') || sym === 'XBT') return 'crypto_bitcoin';
      if (sym.includes('ETH')) return 'crypto_ethereum';
      if (sym === 'USDT' || sym === 'USDC' || sym === 'DAI' || sym === 'BUSD') return 'crypto_stablecoin';
      return 'crypto_altcoins';
    }
    if (lv === 'bitcoin' || lv === 'btc') return 'crypto_bitcoin';
    if (lv === 'ethereum' || lv === 'eth') return 'crypto_ethereum';
    if (lv === 'stablecoin' || lv === 'stablecoins') return 'crypto_stablecoin';
    if (lv === 'altcoin' || lv === 'altcoins') return 'crypto_altcoins';

    // Equity génériques
    if (lv === 'equity' || lv === 'stocks' || lv === 'equities') return 'equity_us_large';
    if (lv === 'equity_us') return 'equity_us_large';

    // Bonds / credit
    if (lv === 'bond' || lv === 'bonds' || lv === 'govt_bonds' || lv === 'sovereign') return 'govt_bonds_us';
    if (lv === 'credit' || lv === 'corporate_bonds') return 'credit_ig';
    if (lv === 'high_yield' || lv === 'hy') return 'credit_hy';

    // FX
    if (lv === 'fx' || lv === 'forex' || lv === 'currency') return 'fx_g10';

    // Commodities
    if (lv === 'commodity' || lv === 'commodities') return 'commodities_metals_precious';
    if (lv === 'gold' || lv === 'silver' || lv === 'precious_metals') return 'commodities_metals_precious';
    if (lv === 'oil' || lv === 'energy' || lv === 'natgas') return 'commodities_energy';

    // Derivatives
    if (lv === 'derivative' || lv === 'derivatives') return 'derivatives_futures';
    if (lv === 'vix' || lv === 'volatility' || lv === 'vol') return 'derivatives_vol';
    if (lv === 'options') return 'derivatives_options';
    if (lv === 'futures') return 'derivatives_futures';

    // Inconnu : on renvoie la valeur originale, Zod produira une erreur explicite
    return v;
  }

  /**
   * Default risk lens placeholder — sera remplacé par un calcul réel
   * dans P4.6 (allocation proposer) une fois les expressions fixées.
   */
  private computeDefaultRiskLens(): AllocationProposal['portfolioRiskLens'] {
    return {
      annualizedVolatilityPct: 0,
      var95_1day_pct: 0,
      expectedShortfall95_1day_pct: 0,
      historicalMaxDrawdownPct: 0,
      daysToExit50pct: 0,
      correlationsToMajorAssets: {},
      effectiveLeverage: 0,
      beta: 0,
      regimeSensitivity: {},
    };
  }
}
