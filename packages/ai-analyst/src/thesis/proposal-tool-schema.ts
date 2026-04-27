/**
 * Schema Anthropic tool_use pour la sortie d'une proposition Lisa.
 *
 * En passant ce schema dans `tools` + `tool_choice: { type: 'tool', name: ... }`,
 * Claude est OBLIGÉ de produire un JSON conforme — l'API Anthropic valide la
 * structure côté serveur et re-prompte si nécessaire. Élimine 100% des parse
 * failures côté SmartVest.
 *
 * Le schema mirror les types Zod de packages/ai-analyst/src/types/index.ts.
 * Si tu modifies un enum côté Zod, met à jour ici aussi.
 */

const ASSET_CLASS_ENUM = [
  'equity_us_large', 'equity_us_small', 'equity_eu', 'equity_em', 'equity_jp', 'equity_cn',
  'govt_bonds_us', 'govt_bonds_eu', 'govt_bonds_em',
  'credit_ig', 'credit_hy', 'credit_em', 'credit_private',
  'fx_g10', 'fx_em', 'fx_exotic',
  'commodities_energy', 'commodities_metals_precious', 'commodities_metals_industrial',
  'commodities_agri',
  'crypto_bitcoin', 'crypto_ethereum', 'crypto_altcoins', 'crypto_stablecoin',
  'derivatives_options', 'derivatives_futures', 'derivatives_swaps', 'derivatives_vol',
  'structured_products', 'real_estate', 'alt_hedge_funds', 'cash',
] as const;

const MARKET_REGIME_ENUM = [
  'risk_on_reflation', 'risk_on_goldilocks', 'risk_off_flight_to_quality',
  'risk_off_liquidity_crunch', 'stagflation', 'deflationary_shock',
  'late_cycle_peak', 'early_cycle_recovery', 'mid_cycle_expansion',
  'policy_pivot_dovish', 'policy_pivot_hawkish', 'geopolitical_stress',
  'tech_bubble_euphoria', 'fragmented_no_consensus',
] as const;

const THESIS_CATEGORY_ENUM = [
  'hidden_gem', 'turnaround', 'flow_timing', 'watchlist',
  'contrarian', 'mean_reversion', 'event_driven',
] as const;

const DIRECTION_ENUM = [
  'long', 'short', 'long_call', 'long_put', 'short_call', 'short_put', 'pair_spread',
] as const;

const SIZING_METHOD_ENUM = [
  'fixed_notional', 'pct_portfolio', 'kelly_fraction', 'risk_parity', 'vol_targeting',
] as const;

// metricType passé en string libre (cf. proposal-tool-schema l.111 + types/index.ts)
// après observation de rejets répétés sur valeurs sémantiquement valides mais
// non listées (ex. funding_pct, oi_change, support, breakout, momentum...).
// L'enum strict gaspillait des cycles Lisa. Validation custom dans description.
const THRESHOLD_DIRECTION_ENUM = ['above', 'below', 'cross', 'occurs'] as const;
const DRIVER_TYPE_ENUM = [
  'fundamentals_cashflow', 'fundamentals_spreads', 'flows_positioning',
  'pure_narrative', 'mixed',
] as const;
const EVIDENCE_TYPE_ENUM = ['hard_data', 'soft_data', 'qualitative', 'speculative'] as const;
const SESSION_PROFILE_ENUM = ['long_term_investor', 'active_trading', 'sniper_mode', 'hyper_active'] as const;

const expressionSchema = {
  type: 'object',
  properties: {
    symbol: { type: 'string', description: 'Ticker exact (BTC, AAPL, EURUSD, ...)' },
    name: { type: 'string', description: 'Nom humain de l\'instrument' },
    assetClass: { type: 'string', enum: ASSET_CLASS_ENUM },
    preferredVenue: { type: 'string', description: 'IBKR | Saxo | Binance | Kraken | etc.' },
    direction: { type: 'string', enum: DIRECTION_ENUM },
    sizingMethod: { type: 'string', enum: SIZING_METHOD_ENUM },
    sizingValue: { type: 'string', description: 'Decimal as string (ex: "0.10" pour 10%)' },
    estimatedCostBps: { type: 'integer', minimum: 0, description: 'Coût total entrée en bps' },
    averageDailyVolumeUsd: { type: ['string', 'null'], description: 'ADV en USD (decimal as string) ou null' },
    whyThisExpression: { type: 'string', description: 'Pourquoi cette expression vs les autres' },
  },
  required: ['symbol', 'name', 'assetClass', 'preferredVenue', 'direction', 'sizingMethod', 'sizingValue', 'estimatedCostBps', 'whyThisExpression'],
};

const thesisSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 200, description: 'Nom court lisible humain' },
    summary: { type: 'string', description: 'Résumé 3-7 lignes max' },
    catalyst: { type: 'string', description: 'Catalyseur principal (1-3 phrases)' },
    whoIsWrong: { type: 'string', description: 'Qui est mal positionné (1-2 phrases)' },
    category: { type: 'string', enum: THESIS_CATEGORY_ENUM },
    expressions: { type: 'array', minItems: 1, items: expressionSchema },
    preferredExpressionIndex: { type: 'integer', minimum: 0 },
    expressionChoiceRationale: { type: 'string' },
    riskReward: {
      type: 'object',
      properties: {
        centralScenarioReturnPct: {
          type: 'object',
          properties: {
            low: { type: 'number' },
            mid: { type: 'number' },
            high: { type: 'number' },
          },
          required: ['low', 'mid', 'high'],
        },
        adverseScenarioReturnPct: { type: 'number', description: 'Scénario adverse en % (négatif)' },
        riskRewardRatio: { type: 'number' },
        horizonDays: { type: 'integer', minimum: 1 },
        convexitySources: { type: 'array', items: { type: 'string' } },
      },
      required: ['centralScenarioReturnPct', 'adverseScenarioReturnPct', 'riskRewardRatio', 'horizonDays', 'convexitySources'],
    },
    invalidation: {
      type: 'object',
      properties: {
        conditions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              metricType: { type: 'string', maxLength: 50, description: 'Métrique surveillée pour invalidation. Valeurs courantes : price, yield, spread, vix, dxy, rsi, macd, volume, level, funding_rate, open_interest, sentiment_score, support, resistance, breakout. Lisa peut utiliser une métrique custom si justifiée par description.' },
              thresholdValue: { type: ['string', 'null'] },
              thresholdDirection: { type: ['string', 'null'], enum: [...THRESHOLD_DIRECTION_ENUM, null] },
            },
            required: ['description', 'metricType'],
          },
        },
        qualitativeConditions: { type: 'array', items: { type: 'string' } },
      },
      required: ['conditions', 'qualitativeConditions'],
    },
    antiBullshit: {
      type: 'object',
      properties: {
        isCrowded: { type: 'boolean' },
        isCrowdedRationale: { type: 'string' },
        driverType: { type: 'string', enum: DRIVER_TYPE_ENUM },
        evidenceType: { type: 'string', enum: EVIDENCE_TYPE_ENUM },
        selfCritique: { type: 'string' },
      },
      required: ['isCrowded', 'isCrowdedRationale', 'driverType', 'evidenceType', 'selfCritique'],
    },
    analogSlugs: { type: 'array', items: { type: 'string' }, description: 'Slugs du historical_events_corpus consultés' },
    confidenceScore: { type: 'integer', minimum: 0, maximum: 100 },
    autonomyRules: {
      type: 'array',
      maxItems: 5,
      description: 'Règles évaluées toutes les 60s par le mécanique. Permettent une réactivité H24 entre cycles Lisa. Cap 5 règles par thèse pour éviter combinatoire chaotique. Métriques: vix, price, funding_annual_pct, pnl_pct. Actions: close, tighten_stop, scale_down_50pct, take_profit. Chaque règle doit être justifiée et non-redondante avec les invalidation conditions.',
      items: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: ['vix', 'price', 'funding_annual_pct', 'pnl_pct'] },
          op: { type: 'string', enum: ['gt', 'lt', 'gte', 'lte'] },
          value: { type: 'number' },
          action: { type: 'string', enum: ['close', 'tighten_stop', 'scale_down_50pct', 'take_profit'] },
          reason: { type: 'string', maxLength: 200 },
        },
        required: ['metric', 'op', 'value', 'action', 'reason'],
      },
    },
    themes: {
      type: 'array',
      maxItems: 2,
      description: "PATCH 3 — Tags thématiques transverses aux classes d'actifs (1-2 max). Capture la concentration de risque qu'un cap par classe ne capte pas (ex: GDX equity + SLV commodity + RTX equity = 3 classes mais 1 thème geopolitical_safehaven). Choisis les thèmes les plus dominants de la thèse parmi la liste enum. Si rien ne colle, utilise 'other'.",
      items: {
        type: 'string',
        enum: [
          'geopolitical_safehaven',
          'ai_megacap',
          'energy_disruption',
          'crypto',
          'defensive_bond_proxy',
          'small_cap_breakout',
          'other',
        ],
      },
    },
    kind: {
      type: 'string',
      enum: ['momentum', 'mean_reversion', 'breakout', 'event', 'macro_hedge'],
      description: "PATCH 5 — Type de thèse pour calibrer la posture de risque (multiplicateur ATR du stop). Orthogonal à 'category'. momentum=1.0× ATR (stop serré, sortie sur cassure de momentum), mean_reversion=2.0× (stop large, drawdown initial attendu), breakout=1.2× (stop sous niveau cassé, faux breakouts), event=1.5× (volatilité event), macro_hedge=2.2× (couverture long-terme). Si tu hésites, choisir 'momentum' (default conservateur).",
    },
  },
  required: ['title', 'summary', 'catalyst', 'whoIsWrong', 'category', 'expressions', 'preferredExpressionIndex', 'expressionChoiceRationale', 'riskReward', 'invalidation', 'antiBullshit', 'analogSlugs', 'confidenceScore'],
};

export const PROPOSAL_TOOL = {
  name: 'submit_proposal',
  description: 'Submit a complete Lisa investment proposal with market context, '
    + 'investment theses, allocation suggestions, and recommendations to close existing positions. '
    + 'This is the ONLY way to communicate your output — do not write any text outside this tool call.',
  input_schema: {
    type: 'object',
    properties: {
      sessionMeta: {
        type: 'object',
        properties: {
          timestamp: { type: 'string', description: 'ISO 8601 UTC' },
          profile: { type: 'string', enum: SESSION_PROFILE_ENUM },
          antiConsensusStrength: { type: 'integer', minimum: 0, maximum: 10 },
        },
        required: ['timestamp', 'profile', 'antiConsensusStrength'],
      },
      marketContext: {
        type: 'object',
        properties: {
          regime: { type: 'string', enum: MARKET_REGIME_ENUM },
          regimeSummary: { type: 'string', description: 'Synthèse macro 3-7 lignes' },
          regimeDrivers: { type: 'array', items: { type: 'string' } },
          marketMomentum: {
            type: 'string',
            enum: ['bullish_strong', 'neutral', 'bearish'],
            description: 'Momentum directionnel détecté sur ce cycle. '
              + 'bullish_strong = ≥2 positions existantes en gain latent ≥+1% dans le même sens régime '
              + 'OU catalyseur réalisé (Fed dovish confirmée, earnings beat majeur, breakout multi-actifs). '
              + 'bearish = positions en drawdown coordonné, VIX en hausse, flight-to-quality visible. '
              + 'neutral = pas de signal directionnel clair. '
              + 'Gouverne les garde-fous dynamiques (cap ouvertures / cooldown). '
              + 'DOIT être justifié dans warnings si non-neutral.',
          },
          vix: { type: 'number' },
          usdDxy: { type: 'number' },
          us10yYield: { type: 'number' },
          brentUsd: { type: 'number' },
          btcUsd: { type: 'number' },
          goldUsd: { type: 'number' },
        },
        required: ['regime', 'regimeSummary', 'regimeDrivers'],
      },
      poolsScan: {
        type: 'object',
        properties: {
          favored: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                assetClass: { type: 'string', enum: ASSET_CLASS_ENUM },
                rationale: { type: 'string' },
                confidenceScore: { type: 'integer', minimum: 0, maximum: 100 },
              },
              required: ['assetClass', 'rationale'],
            },
          },
          avoided: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                assetClass: { type: 'string', enum: ASSET_CLASS_ENUM },
                rationale: { type: 'string' },
              },
              required: ['assetClass', 'rationale'],
            },
          },
        },
        required: ['favored', 'avoided'],
      },
      theses: { type: 'array', minItems: 0, maxItems: 7, items: thesisSchema },
      allocationSuggestion: {
        type: 'object',
        properties: {
          totalCapitalUsd: { type: 'string', description: 'Decimal as string' },
          perThesis: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                thesisId: { type: 'string', description: 'Réfère un title/index de thèse — sera réassigné UUID côté serveur' },
                pctCapital: { type: 'number', minimum: 0, maximum: 100 },
                amountUsd: { type: 'string' },
              },
              required: ['thesisId', 'pctCapital', 'amountUsd'],
            },
          },
          cashReservePct: { type: 'number', minimum: 0, maximum: 100 },
        },
        required: ['totalCapitalUsd', 'perThesis', 'cashReservePct'],
      },
      closeRecommendations: {
        type: 'array',
        description: 'Positions ouvertes à fermer MAINTENANT. Liste vide si aucune.',
        items: {
          type: 'object',
          properties: {
            positionId: { type: 'string', description: 'Copier exactement l\'id depuis le bloc POSITIONS ACTUELLEMENT OUVERTES' },
            reason: { type: 'string', description: 'Rationale courte' },
          },
          required: ['positionId', 'reason'],
        },
      },
      warnings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Warnings utilisateur (régime ambigu, données manquantes, etc.)',
      },
      sessionNotes: {
        type: 'object',
        properties: {
          marketNoiseIgnored: { type: 'string' },
          topOpportunityZones: { type: 'array', items: { type: 'string' } },
          processLearnings: { type: 'string' },
        },
      },
    },
    required: ['marketContext', 'theses', 'allocationSuggestion'],
  },
} as const;

export type ProposalToolInput = {
  sessionMeta?: { timestamp: string; profile: string; antiConsensusStrength: number };
  marketContext: {
    regime: string;
    regimeSummary: string;
    regimeDrivers: string[];
    vix?: number; usdDxy?: number; us10yYield?: number;
    brentUsd?: number; btcUsd?: number; goldUsd?: number;
  };
  poolsScan?: {
    favored: Array<{ assetClass: string; rationale: string; confidenceScore?: number }>;
    avoided: Array<{ assetClass: string; rationale: string }>;
  };
  theses: Array<Record<string, unknown>>;
  allocationSuggestion: {
    totalCapitalUsd: string;
    perThesis: Array<{ thesisId: string; pctCapital: number; amountUsd: string }>;
    cashReservePct: number;
  };
  closeRecommendations?: Array<{ positionId: string; reason: string }>;
  warnings?: string[];
  sessionNotes?: { marketNoiseIgnored?: string; topOpportunityZones?: string[]; processLearnings?: string };
};
