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
import JSON5 from 'json5';
import { z } from 'zod';
import { PROPOSAL_TOOL } from './proposal-tool-schema';
import type { LisaClaudeClient } from '../claude/client';
import type { CorpusQueryService } from '../corpus/corpus-query.service';
import type {
  AllocationProposal,
  HistoryMetrics,
  LisaSessionConfig,
  LisaThesis,
  MarketRegime,
  PerformanceObjectives,
  SessionProfile,
  TrajectoryStatus,
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
    /** Score sentiment EODHD : -1 (très négatif) → +1 (très positif).
     *  null si non fourni. Lisa s'en sert pour pondérer le narrative. */
    sentiment?: number | null;
  }>;
  /** Economic calendar 7 jours à venir */
  upcomingEvents: Array<{
    name: string;
    date: string;
    importance: 'high' | 'medium' | 'low';
  }>;
  /** Contexte macro structurant (réels fournis par /api/macro-indicator).
   *  Optionnel — si absent, Lisa opère sur VIX/DXY only. */
  macroContext?: {
    country: string;
    realRateUsPct: number | null;
    inflationYoyPct: number | null;
    unemploymentPct: number | null;
    gdpYoyPct: number | null;
  };
  /** Candidats du screener EODHD (momentum / oversold / volume anomaly).
   *  Permet à Lisa de découvrir des tickers au-delà de son univers mental. */
  screenerCandidates?: string; // texte pré-formaté
  /** Signaux insider SEC Form 4 par ticker (positions ouvertes + watchlist).
   *  Texte pré-formaté type "TSLA INSIDER(30d): net=+2.4M$ · C-suite=+2.4M$". */
  insiderSignals?: string;
  /** Snapshot options IV + put/call ratio par ticker.
   *  Texte pré-formaté type "AAPL OPTS: IV ATM=28% · P/C=0.82 (bullish)". */
  optionsSignals?: string;
  /** Liquidations crypto (1h / 24h) avec détection de wave.
   *  Texte pré-formaté type "LIQ wave BTC long $42M/1h → reversal probable". */
  liquidationsSignals?: string;
  /** Analyse news scorée + dédoublonnée + filtrée par pertinence (NewsRankerService).
   *  Format texte avec score [0-100], rationale (catalyst/source tier/macro/dédup),
   *  buckets pertinent/bruit/écarté. Remplace `recentNews` naïf en hyper_active. */
  newsAnalysis?: string;
  /** Mémoire des décisions passées de Lisa sur ce portefeuille, agrégée par
   *  regime détecté (LisaMemoryService). Format texte : count, win rate,
   *  return moyen par regime + dernier rationale. Permet à Lisa de calibrer
   *  sa confiance contextuelle (regime déjà rencontré → données empiriques). */
  lisaMemory?: string;
}

export interface OpenPositionSummary {
  positionId: string;
  symbol: string;
  assetClass: string;
  direction: string;
  entryPrice: string;
  currentPrice: string;
  quantity: string;
  entryNotionalUsd: string;
  unrealizedPnlPct: number;
  ageDays: number;
  horizonDays: number | null;
  fundamentals?: {
    pe: number | null;
    forwardPE: number | null;
    revenueGrowthPct: number | null;
    beta: number | null;
    dividendYieldPct: number | null;
    marketCapUsd: number | null;
    sector: string | null;
    industry: string | null;
  } | null;
  nextEarning?: {
    symbol: string;
    reportDate: string;
    epsEstimate: number | null;
    revenueEstimate: number | null;
  } | null;
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
  /** Positions actuellement ouvertes — permet à Claude de recommander leur
   *  fermeture (gestion active vs accumulation passive). */
  openPositions?: OpenPositionSummary[];
  /** Cash disponible en USD après fermeture des positions recommandées. */
  availableCashUsd?: string;
  /** Objectifs de performance nets de coûts (optionnels). Si null, Lisa opère
   *  sans cible chiffrée — comportement original préservé. */
  objectives?: PerformanceObjectives;
  /** Métriques historiques calculées avant cycle (7d/30d + coûts + streak). */
  historyMetrics?: HistoryMetrics;
  /** Statut de trajectoire dérivé par le back depuis objectives + metrics. */
  trajectoryStatus?: TrajectoryStatus | null;
  /** Cible extrapolée sur 7 j (issue des objectifs). */
  targetExtrapolated7dPct?: number | null;
  /** Indicateurs techniques EODHD par symbole ouvert (RSI14/MACD/ATR14/BB20).
   *  Permet à Lisa de décider gestion active (RSI overbought → take profit)
   *  et à l'agent de dimensionner les stops ATR-based. */
  technicalBySymbol?: Record<string, {
    rsi14: number | null;
    macd: number | null;
    macdSignal: number | null;
    macdHist: number | null;
    atr14: number | null;
    atr14Pct: number | null;
    bbUpper: number | null;
    bbMiddle: number | null;
    bbLower: number | null;
    bbPctB: number | null;
  }>;
  /** Résumés intraday 5m (20 bougies, ~1h40 de contexte) par symbole ouvert.
   *  Format texte prêt à injecter dans le briefing Lisa : momentum, range,
   *  volume surge. Permet à Lisa de distinguer breakout vs fakeout. */
  intradayBySymbol?: Record<string, string>;
  /** Earnings calendar : prochaine date d'earnings par symbole equity dans
   *  les 30 prochains jours. Format YYYY-MM-DD. Permet à Lisa d'éviter de
   *  proposer une thèse equity dont le horizon couvre l'earnings (event
   *  binaire), ou au contraire de positionner explicitement event-driven
   *  via long_call/long_put. Nul/absent = pas d'earnings dans la fenêtre. */
  earningsBySymbol?: Record<string, string | null>;
}

export interface GenerateThesesResponse {
  proposal: AllocationProposal;
  costUsd: number;
  cacheHitRatio: number | null;
  rawClaudeText: string;
  warnings: string[];
  /** Positions que Lisa recommande de fermer à l'approbation. */
  closeRecommendations: Array<{ positionId: string; reason: string }>;
  /** Métadonnées Claude pour persistance et monitoring quota. */
  claudeMeta: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    stopReason: string | null;
  };
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

    // 3. Call Claude avec tool_use forcé. L'API Anthropic valide le JSON
    //    côté serveur — plus aucune chance de parse failure côté client.
    //    Si Claude essaie de produire du JSON malformé, l'API re-prompte
    //    automatiquement jusqu'à conformité.
    const toolResult = await this.claudeClient.callWithTool({
      profile: req.config.profile,
      userMessage,
      tool: PROPOSAL_TOOL as unknown as { name: string; description: string; input_schema: Record<string, unknown> },
    });

    const parsed = toolResult.input;
    const claudeMeta = {
      model: toolResult.model,
      usage: toolResult.usage,
    };

    // 5. Validate + normalize into AllocationProposal
    const proposal = this.normalizeProposal(parsed, req.config, claudeMeta);

    // 5b. Extract closeRecommendations
    const rawRoot = parsed;
    const closeRecsRaw = (rawRoot.closeRecommendations as Array<Record<string, unknown>> | undefined) ?? [];
    const openPositionIds = new Set((req.openPositions ?? []).map((p) => p.positionId));
    const closeRecommendations = closeRecsRaw
      .map((r) => ({
        positionId: String(r.positionId ?? ''),
        reason: String(r.reason ?? '').slice(0, 500),
      }))
      .filter((r) => r.positionId.length > 0 && openPositionIds.has(r.positionId));

    // 6. Compute metadata
    const costUsd = (this.claudeClient.constructor as typeof LisaClaudeClient)
      .estimateCostUsd(toolResult.usage);

    const totalInput =
      (toolResult.usage.inputTokens ?? 0) +
      (toolResult.usage.cacheReadInputTokens ?? 0) +
      (toolResult.usage.cacheCreationInputTokens ?? 0);
    const cacheHitRatio = totalInput > 0
      ? (toolResult.usage.cacheReadInputTokens ?? 0) / totalInput
      : null;

    return {
      proposal,
      costUsd,
      cacheHitRatio,
      rawClaudeText: JSON.stringify(parsed).slice(0, 50_000),
      warnings: proposal.warnings,
      closeRecommendations,
      claudeMeta: {
        model: toolResult.model,
        inputTokens: toolResult.usage.inputTokens ?? 0,
        outputTokens: toolResult.usage.outputTokens ?? 0,
        cacheCreationInputTokens: toolResult.usage.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: toolResult.usage.cacheReadInputTokens ?? 0,
        stopReason: toolResult.stopReason,
      },
    };
  }

  private composeUserMessage(req: GenerateThesesRequest, corpusBlock: string): string {
    const m = req.marketSnapshot;
    const config = req.config;

    const recentNewsBlock = m.recentNews
      .slice(0, 10)
      .map((n) => {
        const sent = n.sentiment;
        const sentTag = sent != null
          ? ` · sent=${sent >= 0 ? '+' : ''}${sent.toFixed(2)}${sent > 0.3 ? ' 🟢' : sent < -0.3 ? ' 🔴' : ''}`
          : '';
        return `- [${n.timestamp}] (${n.source}, ${n.relevance}${sentTag}) ${n.headline}`;
      })
      .join('\n');

    // Agrégat sentiment global sur les 10 dernières news pour lecture rapide
    const sentScores = m.recentNews
      .slice(0, 10)
      .map((n) => n.sentiment)
      .filter((s): s is number => typeof s === 'number');
    const avgSentiment = sentScores.length > 0
      ? sentScores.reduce((a, b) => a + b, 0) / sentScores.length
      : null;
    const sentimentLine = avgSentiment != null
      ? `\nSentiment agrégé 10 dernières news : ${avgSentiment >= 0 ? '+' : ''}${avgSentiment.toFixed(2)} (${avgSentiment > 0.15 ? 'bullish tilt' : avgSentiment < -0.15 ? 'bearish tilt' : 'neutre'}, n=${sentScores.length})`
      : '';

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
- Gold: $${m.goldUsd}${m.macroContext ? `

### Macro context (${m.macroContext.country}, dernière publication)
${m.macroContext.realRateUsPct != null ? `- Real rate : ${m.macroContext.realRateUsPct >= 0 ? '+' : ''}${m.macroContext.realRateUsPct.toFixed(2)}%` : ''}
${m.macroContext.inflationYoyPct != null ? `- CPI YoY : ${m.macroContext.inflationYoyPct.toFixed(2)}%` : ''}
${m.macroContext.unemploymentPct != null ? `- Unemployment : ${m.macroContext.unemploymentPct.toFixed(2)}%` : ''}
${m.macroContext.gdpYoyPct != null ? `- GDP YoY : ${m.macroContext.gdpYoyPct >= 0 ? '+' : ''}${m.macroContext.gdpYoyPct.toFixed(2)}%` : ''}` : ''}
- BTC: $${m.btcUsd}
- ETH: $${m.ethUsd}
- EUR/USD: ${m.eurUsd}
- USD/JPY: ${m.usdJpy}
- S&P 500: ${m.sp500}
- Nasdaq: ${m.nasdaq}

${m.lisaMemory ? `## YOUR PAST DECISIONS — mémoire contextuelle sur ce portefeuille
${m.lisaMemory}

` : ''}## Recent news (24-72h) — analyse scorée et filtrée
${m.newsAnalysis ? m.newsAnalysis : (recentNewsBlock || '- (no recent news provided)')}${m.newsAnalysis ? '' : sentimentLine}
${m.screenerCandidates ? `\n## Screener candidates (scans de découverte EODHD)\n${m.screenerCandidates}\n` : ''}${m.insiderSignals ? `\n## Insider signals (SEC Form 4, 30j)\n${m.insiderSignals}\n` : ''}${m.optionsSignals ? `\n## Options flow (IV ATM · put/call ratio)\n${m.optionsSignals}\n` : ''}${m.liquidationsSignals ? `\n## Crypto liquidations (waves reversal)\n${m.liquidationsSignals}\n` : ''}

## Upcoming events (7 days)
${upcomingEventsBlock || '- (no upcoming events provided)'}

# HISTORICAL CORPUS (analogs à disposition)
${corpusBlock || '(no corpus events loaded for this query)'}

# POSITIONS ACTUELLEMENT OUVERTES
${this.formatOpenPositionsBlock(req.openPositions, req.availableCashUsd, req.technicalBySymbol, req.intradayBySymbol, req.earningsBySymbol, req.config.profile)}

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

${this.formatMissionBlock(req)}
${req.userFocus ? `\n# USER FOCUS\n${req.userFocus}\n` : ''}

# STRUCTURE DE TA RÉPONSE (obligatoire)
Le champ \`warnings\` DOIT contenir au minimum 3 éléments, dans l'ordre,
préfixés exactement :
1. "[DIAGNOSTIC] ..." — objectifs vs réalité, coût vs gain, concentration
   de risque, écart à la trajectoire cible. Cite les chiffres du bloc
   # MISSION ci-dessus.
2. "[PLAN] ..." — actions concrètes ce cycle (exposition cible, nb
   positions max, taille cible, style : opportuniste / sélectif /
   défensif). Si "ne rien faire", justifie-le explicitement comme plan.
3. "[CONDITIONS] ..." — signaux de marché / P&L / coûts qui invalideraient
   ce plan et déclencheraient un ajustement au prochain cycle.

Les autres warnings (régime ambigu, données manquantes, etc.) viennent
APRÈS ces trois entrées, dans l'ordre libre.

# MARKET MOMENTUM — flag obligatoire \`marketContext.marketMomentum\`
Tu DOIS classer le momentum du cycle parmi :

- \`bullish_strong\` → au moins 2 positions existantes sont en gain latent
  ≥ +1 % dans le même sens régime (ex. risk-on broad), OU un catalyseur
  majeur vient d'être réalisé (Fed dovish confirmée, earnings beat
  significatif, breakout multi-actifs coordonné). Dans ce cas tu dois
  JUSTIFIER le flag dans \`warnings\` en citant les positions ou le
  catalyseur concernés — pas de justification = pas de \`bullish_strong\`.

- \`bearish\` → positions en drawdown coordonné, VIX en hausse franche,
  flight-to-quality visible (USD/JPY ou bons du Trésor en bid, or en
  rally défensif). Justifie aussi dans \`warnings\`.

- \`neutral\` → aucun signal directionnel clair ; c'est la valeur par
  défaut, pas besoin de justification spéciale.

**Ce flag gouverne les garde-fous serveur (cap d'ouvertures + cooldown) :**
- \`bullish_strong\` : cap d'ouvertures élargi (4 vs 2), cooldown bypass.
- \`neutral\` : cap par défaut (2), cooldown 15 min.
- \`bearish\` : cap serré (1), cooldown rallongé (20 min).

Tu restes libre de proposer 0 thèse quelle que soit la valeur — le flag
autorise la réactivité, il ne l'impose pas.

# REQUEST
Applique TA méthode Lisa complète. Renvoie UNIQUEMENT le JSON au format
défini, sans markdown, sans explications hors JSON.
`.trim();
  }

  /**
   * Bloc # MISSION — trajectoire portefeuille.
   * Agrège objectifs + métriques + écart/statut pour que Claude raisonne en
   * termes d'alignement à la trajectoire cible (v2 persona).
   * Si aucune métrique n'est fournie (ex : appels legacy sans objectives),
   * renvoie une string vide pour préserver l'ancien comportement.
   */
  private formatMissionBlock(req: GenerateThesesRequest): string {
    const objectives = req.objectives;
    const metrics = req.historyMetrics;
    if (!objectives && !metrics) return '';

    const capitalNum = parseFloat(req.config.capitalUsd);
    const amountPerDay =
      objectives?.returnTargetDailyPct != null
        ? ((objectives.returnTargetDailyPct / 100) * capitalNum).toFixed(2)
        : null;
    const fmtPct = (v: number | null | undefined, digits = 2) =>
      v === null || v === undefined ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
    const fmtUsd = (v: number | null | undefined, digits = 2) =>
      v === null || v === undefined ? 'n/a' : `$${v.toFixed(digits)}`;

    const objLines: string[] = [];
    if (objectives) {
      if (objectives.returnTargetDailyPct != null) {
        objLines.push(
          `- Quotidien : +${objectives.returnTargetDailyPct.toFixed(2)}%` +
            (amountPerDay ? ` (~$${amountPerDay} sur capital $${capitalNum.toFixed(0)})` : ''),
        );
      } else {
        objLines.push(`- Quotidien : non fixé`);
      }
      objLines.push(
        `- Mensuel : ${objectives.returnTargetMonthlyPct != null ? `+${objectives.returnTargetMonthlyPct.toFixed(2)}%` : 'non fixé'}`,
      );
      objLines.push(
        `- Annuel : ${objectives.returnTargetAnnualPct != null ? `+${objectives.returnTargetAnnualPct.toFixed(2)}%` : 'non fixé'}`,
      );
      if (
        objectives.returnTargetDailyPct === null &&
        objectives.returnTargetMonthlyPct === null &&
        objectives.returnTargetAnnualPct === null
      ) {
        objLines.push(`(null partout = Lisa opère en conviction libre, sans cible chiffrée)`);
      }
    }

    const costLines: string[] = [];
    if (metrics) {
      const cb = metrics.costBreakdown;
      const total = cb.claudeUsd + cb.eodhdUsd + cb.tradingFrictionsUsd;
      costLines.push(
        `- Claude : ${fmtUsd(cb.claudeUsd)} · EODHD : ${fmtUsd(cb.eodhdUsd, 4)} · Trading (fees+spread+slip) : ${fmtUsd(cb.tradingFrictionsUsd)}`,
      );
      const dailyAvg = metrics.avgDailyCostUsd7d;
      const budgetLine =
        objectives?.dailyCostBudgetUsd != null
          ? ` · Budget max : ${fmtUsd(objectives.dailyCostBudgetUsd)} · Consommation : ${
              dailyAvg != null ? `${Math.min(999, Math.round((dailyAvg / objectives.dailyCostBudgetUsd) * 100))}%` : 'n/a'
            }`
          : '';
      costLines.push(`- Total 7j : ${fmtUsd(total)} · Moyenne/jour : ${fmtUsd(dailyAvg)}${budgetLine}`);
    }

    const histLines: string[] = [];
    if (metrics) {
      histLines.push(
        `- Return inception : ${fmtPct(metrics.netReturnFromInceptionPct)} · Drawdown peak : ${fmtPct(metrics.drawdownFromPeakPct)}`,
      );
      histLines.push(
        `- Return 7j : ${fmtPct(metrics.netReturn7dPct)} · Return 30j : ${fmtPct(metrics.netReturn30dPct)}`,
      );
      histLines.push(
        `- Volatilité réalisée 7j : ${fmtPct(metrics.realizedVolatility7dPct)} · Win rate : ${
          metrics.winRatePct != null ? `${metrics.winRatePct.toFixed(0)}% (${metrics.closedPositionsCount} closed)` : 'n/a'
        }`,
      );
      if (metrics.recentStreak) {
        const label = metrics.recentStreak.kind === 'wins' ? 'gains' : 'pertes';
        histLines.push(`- Streak : ${metrics.recentStreak.count} ${label} consécutifs`);
      } else {
        histLines.push(`- Streak : aucune séquence claire (ou historique insuffisant)`);
      }
    }

    const isHyperActive = req.config.profile === 'hyper_active';
    const gapLines: string[] = [];
    if (req.trajectoryStatus && req.targetExtrapolated7dPct != null && metrics?.netReturn7dPct != null) {
      const statusLabel =
        req.trajectoryStatus === 'EN_AVANCE'
          ? '**EN AVANCE** — sélectivité peut être relâchée (cap +1, conviction mini abaissée)'
          : req.trajectoryStatus === 'DANS_LE_PLAN'
            ? '**DANS LE PLAN** — régime normal, pas de changement de posture'
            : req.trajectoryStatus === 'EN_RETARD'
              ? `**EN RETARD** — examiner d'abord si le risque est sous-utilisé (drawdown ${fmtPct(metrics.drawdownFromPeakPct)} << limite), sinon envisager révision d'objectif`
              : isHyperActive
                ? `**HORS TRAJECTOIRE (hyper_active)** — coûts > 50% des gains 7j. En profile hyper_active, ce n'est PAS un signal de retrait : continue à proposer 1-3 setups asymétriques par cycle (R/R ≥ 2:1 conviction ≥6) pour réduire le ratio coûts/gains. La passivité n'est PAS la solution — le drift négatif des frais API empire si tu ne tradees pas. Signale en [DIAGNOSTIC] mais NE renvoie PAS theses=[].`
                : `**HORS TRAJECTOIRE** — objectif structurellement irréaliste dans la configuration actuelle OU coûts > 50% des gains bruts. Signale-le dans [DIAGNOSTIC] et propose révision (cible, horizon, risque)`;
      const delta = metrics.netReturn7dPct - req.targetExtrapolated7dPct;
      gapLines.push(
        `- Cible 7j extrapolée : ${fmtPct(req.targetExtrapolated7dPct)} · Réalisé 7j : ${fmtPct(metrics.netReturn7dPct)}`,
      );
      gapLines.push(`- Écart : ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} pt · Statut : ${statusLabel}`);
    } else if (objectives && Object.values(objectives).some((v) => v !== null && v !== 30)) {
      gapLines.push(`- Historique 7j insuffisant pour mesurer l'écart — tenir compte de l'objectif dans les arbitrages à venir`);
    }

    // Agent mécanique — briefing structuré pour Lisa
    const mechLines: string[] = [];
    const mc = metrics?.lastMechanicalCycle ?? null;
    if (mc) {
      const cycleAge = Math.round((Date.now() - new Date(mc.cycleAt).getTime()) / 60000);
      mechLines.push(
        `- Dernier cycle : il y a ${cycleAge} min · Directive âgée de ${mc.directiveAgeMinutes ?? '?'} min`,
      );
      mechLines.push(
        `- Ouvertures : ${mc.opensCount} · Stops touchés : ${mc.closesStopCount} · Targets atteints : ${mc.closesTargetCount} · Invalidés : ${mc.closesInvalidatedCount}`,
      );
      const pnlSign = mc.netPnlSinceProposalUsd >= 0 ? '+' : '';
      mechLines.push(
        `- P&L mécanique : ${pnlSign}$${mc.netPnlSinceProposalUsd.toFixed(2)} · Win rate : ${mc.winRatePct != null ? `${mc.winRatePct.toFixed(0)}%` : 'n/a'} · Hold moyen : ${mc.avgHoldMinutes != null ? `${mc.avgHoldMinutes.toFixed(0)} min` : 'n/a'}`,
      );
      if (mc.largestWinPct != null || mc.largestLossPct != null) {
        mechLines.push(
          `- Outliers : meilleur gain ${mc.largestWinPct != null ? `+${mc.largestWinPct.toFixed(2)}%` : 'n/a'} · pire perte ${mc.largestLossPct != null ? `${mc.largestLossPct.toFixed(2)}%` : 'n/a'}`,
        );
      }
      if (mc.stopsClusterFlag) {
        mechLines.push(
          `- ⚠️ ALERTE RÉGIME : ${mc.closesStopCount} stops en ${mc.stopsClusterWindowMinutes ?? '?'} min → possible rupture de régime intraday. Réévalue la thèse directionnelle dans [DIAGNOSTIC].`,
        );
      }
      mechLines.push(
        `- Exposition : ${mc.exposurePct != null ? `${mc.exposurePct.toFixed(1)}%` : 'n/a'} capital · Cash : ${mc.cashUsd != null ? `$${mc.cashUsd.toFixed(0)}` : 'n/a'} · Positions ouvertes : ${mc.openPositionsCount}`,
      );
      if (mc.drawdownSinceDirectivePct != null) {
        mechLines.push(`- Drawdown depuis directive : -${mc.drawdownSinceDirectivePct.toFixed(2)}%`);
      }
      if (mc.vixLevel != null || mc.dxyLevel != null) {
        mechLines.push(
          `- Macro : VIX ${mc.vixLevel != null ? mc.vixLevel.toFixed(2) : 'n/a'}${mc.vixLevel != null && mc.vixLevel > 25 ? ' (ÉLEVÉ — vigilance)' : ''} · DXY ${mc.dxyLevel != null ? mc.dxyLevel.toFixed(2) : 'n/a'}`,
        );
      }
    } else {
      mechLines.push(`- Aucun cycle mécanique enregistré — agent en attente de première directive.`);
      // Fallback: compute exposure from open positions so Signal E can still trigger
      const positions = req.openPositions ?? [];
      if (positions.length > 0) {
        const totalNotional = positions.reduce((s, p) => s + parseFloat(p.entryNotionalUsd), 0);
        const cashUsd = req.availableCashUsd ? parseFloat(req.availableCashUsd) : 0;
        const totalCapital = totalNotional + cashUsd;
        const exposurePct = totalCapital > 0 ? (totalNotional / totalCapital) * 100 : null;
        if (exposurePct != null) {
          mechLines.push(
            `- Exposition estimée (depuis positions ouvertes) : ${exposurePct.toFixed(1)}% capital · Cash : $${cashUsd.toFixed(0)} · ${positions.length} positions${exposurePct > 75 ? ' ⚠️ EXPOSITION ÉLEVÉE — Signal E actif' : ''}`,
          );
        }
      }
    }

    return [
      '',
      '# MISSION — TRAJECTOIRE PORTEFEUILLE',
      '',
      objLines.length > 0 ? `## Objectifs (nets de coûts)\n${objLines.join('\n')}` : '',
      costLines.length > 0 ? `\n## Coûts journaliers (moyenne 7j)\n${costLines.join('\n')}` : '',
      histLines.length > 0 ? `\n## Historique récent\n${histLines.join('\n')}` : '',
      gapLines.length > 0
        ? `\n## Écart à la trajectoire cible (horizon ${objectives?.performanceHorizonDays ?? 30}j, mesure 7j)\n${gapLines.join('\n')}`
        : '',
      `\n## Agent mécanique (depuis dernière directive)\n${mechLines.join('\n')}`,
    ]
      .filter((s) => s !== '')
      .join('\n');
  }

  /**
   * Format le bloc "positions ouvertes" pour que Claude puisse recommander
   * des fermetures. Chaque ligne est auto-suffisante : Lisa voit le P&L
   * latent, l'âge et le temps restant avant horizon.
   */
  private formatOpenPositionsBlock(
    positions: OpenPositionSummary[] | undefined,
    availableCash: string | undefined,
    technicalBySymbol?: GenerateThesesRequest['technicalBySymbol'],
    intradayBySymbol?: GenerateThesesRequest['intradayBySymbol'],
    earningsBySymbol?: GenerateThesesRequest['earningsBySymbol'],
    profile?: SessionProfile,
  ): string {
    const isHyperActive = profile === 'hyper_active';
    if (!positions || positions.length === 0) {
      return `(aucune position ouverte — marge de manœuvre maximale pour ouvrir)
${availableCash ? `Cash disponible : ${availableCash} USD\n` : ''}
Biais du cycle : OPPORTUNISTE — toute thèse à conviction normale est bienvenue.`;
    }

    // Bandeau agrégé : Lisa doit voir d'un coup d'œil l'état global du
    // portefeuille pour décider si elle ouvre, ferme ou laisse courir.
    const totalEntryNotional = positions.reduce((s, p) => s + parseFloat(p.entryNotionalUsd), 0);
    const weightedPnlPct = totalEntryNotional > 0
      ? positions.reduce((s, p) => s + p.unrealizedPnlPct * (parseFloat(p.entryNotionalUsd) / totalEntryNotional), 0)
      : 0;
    const avgAge = positions.reduce((s, p) => s + p.ageDays, 0) / positions.length;
    const worstPosPnl = Math.min(...positions.map((p) => p.unrealizedPnlPct));

    let bias: 'HOLD recommandé' | 'OPPORTUNISTE' | 'URGENCE RÉÉQUILIBRAGE';
    let biasRationale: string;
    if (worstPosPnl <= -5 || weightedPnlPct <= -2) {
      bias = 'URGENCE RÉÉQUILIBRAGE';
      biasRationale = 'au moins une position dégradée (≤ −5%) ou portefeuille en perte significative — closeRecommendations prioritaires, ouvertures mesurées';
    } else if (isHyperActive) {
      // hyper_active : la passivité (theses=[]) est interdite par défaut.
      // L'utilisateur a explicitement choisi un profil haute fréquence —
      // l'absence de propositions équivaut à du gaspillage de coûts API.
      bias = 'OPPORTUNISTE';
      biasRationale = 'profile hyper_active — propose 1-3 thèses par cycle même si setup B+/A-, pas seulement A+. La passivité (theses=[]) n\'est PAS la réponse par défaut : si vraiment rien n\'émerge, justifie en sessionNotes pourquoi (volatilité écrasée, news en attente, etc.)';
    } else if (weightedPnlPct >= 0.5 && worstPosPnl > -3) {
      bias = 'HOLD recommandé';
      biasRationale = 'portefeuille en gain net, aucune position dégradée — n\'ouvre QUE si une nouvelle thèse a un R/R supérieur au pire R/R existant. Array `theses` vide est la bonne réponse par défaut';
    } else {
      bias = 'OPPORTUNISTE';
      biasRationale = 'portefeuille proche du break-even — propose selon conviction normale';
    }

    const summary = `RÉSUMÉ PORTEFEUILLE : P&L latent global ${weightedPnlPct >= 0 ? '+' : ''}${weightedPnlPct.toFixed(2)}% · ${positions.length} position(s) ouverte(s) · âge moyen ${avgAge.toFixed(1)}j · pire P&L individuel ${worstPosPnl >= 0 ? '+' : ''}${worstPosPnl.toFixed(2)}%
Biais du cycle : **${bias}** — ${biasRationale}`;

    const lines = positions.map((p) => {
      const pnlSign = p.unrealizedPnlPct >= 0 ? '+' : '';
      const horizonHint = p.horizonDays !== null
        ? ` horizon=${Math.max(0, p.horizonDays - p.ageDays)}j restants`
        : '';
      const base = `- id=${p.positionId} ${p.direction.toUpperCase()} ${p.symbol} (${p.assetClass}) qty=${p.quantity} entry=${p.entryPrice} now=${p.currentPrice} pnl=${pnlSign}${p.unrealizedPnlPct.toFixed(2)}% age=${p.ageDays}j${horizonHint} notional=${p.entryNotionalUsd}$`;

      // Enrichissement EODHD : fundamentals + next earning
      const extras: string[] = [];
      if (p.fundamentals) {
        const f = p.fundamentals;
        const parts: string[] = [];
        if (f.sector) parts.push(`sector=${f.sector}`);
        if (f.pe !== null) parts.push(`P/E=${f.pe.toFixed(1)}`);
        if (f.forwardPE !== null) parts.push(`fwd P/E=${f.forwardPE.toFixed(1)}`);
        if (f.revenueGrowthPct !== null) parts.push(`rev YoY=${f.revenueGrowthPct >= 0 ? '+' : ''}${f.revenueGrowthPct.toFixed(1)}%`);
        if (f.beta !== null) parts.push(`β=${f.beta.toFixed(2)}`);
        if (f.dividendYieldPct !== null && f.dividendYieldPct > 0) parts.push(`div=${f.dividendYieldPct.toFixed(1)}%`);
        if (f.marketCapUsd !== null) {
          const mcB = f.marketCapUsd / 1e9;
          parts.push(`mcap=${mcB >= 1000 ? (mcB / 1000).toFixed(1) + 'T' : mcB.toFixed(1) + 'B'}$`);
        }
        if (parts.length > 0) extras.push(`  Fundamentals: ${parts.join(' · ')}`);
      }
      if (p.nextEarning) {
        const e = p.nextEarning;
        const daysTo = Math.ceil((new Date(e.reportDate).getTime() - Date.now()) / 86_400_000);
        if (daysTo >= 0 && daysTo <= 14) {
          const est = e.epsEstimate !== null ? ` (EPS est ${e.epsEstimate.toFixed(2)})` : '';
          extras.push(`  ⚠️ Earnings dans ${daysTo}j : ${e.reportDate}${est}`);
        }
      }
      // Indicateurs techniques EODHD — base pour gestion active et stops ATR
      const ind = technicalBySymbol?.[p.symbol];
      if (ind) {
        const techParts: string[] = [];
        if (ind.rsi14 != null) {
          const tag = ind.rsi14 < 30 ? ' OVERSOLD' : ind.rsi14 > 70 ? ' OVERBOUGHT' : '';
          techParts.push(`RSI14=${ind.rsi14.toFixed(1)}${tag}`);
        }
        if (ind.macdHist != null) {
          techParts.push(`MACD_hist=${ind.macdHist >= 0 ? '+' : ''}${ind.macdHist.toFixed(3)}`);
        }
        if (ind.atr14Pct != null) {
          techParts.push(`ATR14=${ind.atr14Pct.toFixed(2)}%`);
        }
        if (ind.bbPctB != null) {
          const tag = ind.bbPctB > 1 ? ' ABOVE_UPPER' : ind.bbPctB < 0 ? ' BELOW_LOWER' : '';
          techParts.push(`BB_%B=${ind.bbPctB.toFixed(2)}${tag}`);
        }
        if (techParts.length > 0) extras.push(`  Technical: ${techParts.join(' · ')}`);
      }
      // Résumé bougies 5m — price action réel des ~100 dernières minutes
      const intradaySummary = intradayBySymbol?.[p.symbol];
      if (intradaySummary) {
        extras.push(`  Intraday 5m: ${intradaySummary}`);
      }
      // Earnings calendar : event binaire dans la fenêtre horizon ?
      const earningsDate = earningsBySymbol?.[p.symbol];
      if (earningsDate) {
        const daysToEarnings = Math.ceil(
          (new Date(earningsDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        );
        const tag = daysToEarnings <= 5 ? ' ⚠️ EARNINGS IMMINENT' : '';
        extras.push(
          `  📅 Earnings: ${earningsDate} (dans ${daysToEarnings}j)${tag} — décision : (a) close avant si horizon couvre, (b) ou positionnement event-driven option (long_call/long_put)`,
        );
      }
      return extras.length > 0 ? `${base}\n${extras.join('\n')}` : base;
    });
    const cashLine = availableCash
      ? `\nCash disponible : ${availableCash} USD (après fermetures que tu recommandes)`
      : '';
    return `${summary}

${lines.join('\n')}${cashLine}

À partir de cette liste, retourne dans ton tool call un champ
"closeRecommendations" (array, peut être vide) listant les positions à
fermer MAINTENANT, chacune au format :
  { "positionId": "<id copié exact>", "reason": "rationale courte" }

Critères de fermeture typiques :
- P&L latent < -3% ET le scénario d'entrée ne tient plus
- Horizon déjà dépassé ou presque (< 1j restant) sans catalyseur matérialisé
- La thèse sous-jacente est invalidée par un news/macro récent
- R/R retombé sous 1 (asymétrie défavorable)

Ne ferme PAS une position juste parce qu'elle est en légère perte si la
thèse initiale tient toujours (respect du plan, pas de panic-sell).

**IMPORTANT — règle d'ouverture conditionnelle au biais :**
- Biais HOLD recommandé → array \`theses\` vide est la réponse par défaut.
  N'ouvre QUE si tu identifies une opportunité avec R/R strictement
  supérieur au pire R/R des positions ci-dessus.
- Biais OPPORTUNISTE → ouvre selon ta conviction normale.
- Biais URGENCE → priorise les fermetures, ouvertures uniquement si elles
  réduisent l'exposition agrégée ou couvrent un risque concentré.`;
  }

  /**
   * @deprecated Plus utilisé depuis le passage à tool_use (callWithTool).
   * Conservé temporairement comme référence du parser tolérant ; à supprimer
   * une fois confirmé que tool_use est stable en production.
   */
  // @ts-expect-error — méthode privée non utilisée gardée comme référence
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

    // 5. Insert missing commas between adjacent objects/arrays (Claude oubli
    //    fréquent en output long). Ne touche PAS l'intérieur des strings JSON.
    cleaned = this.insertMissingCommas(cleaned);
    parsed = tryParse(cleaned);
    if (parsed !== null) return parsed;

    // 6. JSON5 — parser lenient qui accepte commentaires, trailing commas,
    //    keys non-quotés, strings single-quoted, échappements plus permissifs.
    //    Last chance avant l'erreur.
    try {
      return JSON5.parse(cleaned);
    } catch { /* continue to detailed error */ }

    // 7. Last resort — detailed error with context around first failure
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
   * Insère les virgules manquantes entre deux tokens frères : }{ , ][ , }[ , ]{
   * (cas classique des gros outputs Claude qui oublient un séparateur).
   *
   * On parcourt le texte en tenant compte des strings (entre guillemets) et
   * des échappements pour ne pas modifier l'intérieur d'une valeur string.
   */
  private insertMissingCommas(s: string): string {
    const out: string[] = [];
    let inString = false;
    let escaped = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      out.push(c);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }

      if (c === '}' || c === ']') {
        // Scan forward through whitespace to find next non-space char
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (j < s.length && (s[j] === '{' || s[j] === '[' || s[j] === '"')) {
          // Only insert comma if we're NOT at the very end of an object/array
          // (i.e. a closing brace doesn't follow). Heuristic : if the next
          // non-space-non-brace char suggests a sibling, insert.
          out.push(',');
        }
      }
    }
    return out.join('');
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

    // Extract theses, ensure IDs are valid UUIDs, attach claude meta.
    //
    // Double mapping pour résoudre les allocation.thesisId quelle que soit la
    // forme utilisée par Claude :
    //   - idMap : Claude's original id string → nouvel UUID (si Claude a mis un id)
    //   - positionMap : index numérique de la thèse → nouvel UUID (fallback
    //     quand Claude met un thesisId texte qu'on ne trouve nulle part, on
    //     présume une correspondance 1-à-1 avec allocations dans l'ordre).
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // Filtre les éléments non-objets que Claude glisse parfois dans le tableau
    // (strings orphelines, null, artefacts de parsing). Sans ça, `t.id = …`
    // jette "Cannot create property 'id' on string '['" et casse le cycle.
    const thesesRawUnfiltered = (root.theses as Array<unknown>) ?? [];
    const thesesRaw = thesesRawUnfiltered.filter(
      (t): t is Record<string, unknown> => t !== null && typeof t === 'object' && !Array.isArray(t),
    );
    if (thesesRaw.length !== thesesRawUnfiltered.length) {
      root.theses = thesesRaw;
    }
    const idMap = new Map<string, string>();
    const positionMap = new Map<number, string>();
    for (let i = 0; i < thesesRaw.length; i++) {
      const t = thesesRaw[i];
      const origId = typeof t.id === 'string' ? t.id : '';
      let newId: string;
      if (UUID_RE.test(origId)) {
        newId = origId; // déjà un UUID valide — on garde
      } else {
        newId = randomUUID();
        if (origId) idMap.set(origId, newId);
        t.id = newId;
      }
      positionMap.set(i, newId);
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

    // Allocation suggestion (read before theses map so we can patch thesisId refs).
    //
    // Stratégie de résolution pour chaque a.thesisId, en cascade :
    //   1. Si c'est déjà un UUID valide qui matche une thèse → rien à faire
    //   2. Sinon, si présent dans idMap (Claude a mis un id texte qu'on a mappé) → remplacer
    //   3. Sinon, fallback sur l'index de l'allocation dans perThesis (présume
    //      correspondance 1-à-1 avec theses dans l'ordre) — c'est le cas le plus
    //      fréquent quand Claude utilise des refs type "t1", "thesis-001", etc.
    const allocSug = (root.allocationSuggestion as Record<string, unknown>) ?? {};
    const perThesisRaw = (allocSug.perThesis as Array<Record<string, unknown>>) ?? [];
    const validThesisIds = new Set(Array.from(positionMap.values()));
    for (let i = 0; i < perThesisRaw.length; i++) {
      const a = perThesisRaw[i];
      const current = String(a.thesisId ?? '');
      if (validThesisIds.has(current)) continue; // déjà bon
      const mappedFromId = idMap.get(current);
      if (mappedFromId) {
        a.thesisId = mappedFromId;
        continue;
      }
      // Fallback position-based : allocation[i] → thesis[i]
      const byPosition = positionMap.get(i);
      if (byPosition) a.thesisId = byPosition;
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

    const rawMomentum = typeof mc.marketMomentum === 'string' ? mc.marketMomentum : '';
    const marketMomentum: AllocationProposal['marketMomentum'] =
      rawMomentum === 'bullish_strong' || rawMomentum === 'bearish' ? rawMomentum : 'neutral';

    const proposal: AllocationProposal = {
      id: randomUUID(),
      capitalUsd: config.capitalUsd,
      baseCurrency: config.baseCurrency,
      detectedRegime: (mc.regime as MarketRegime) ?? 'fragmented_no_consensus',
      marketMomentum,
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
