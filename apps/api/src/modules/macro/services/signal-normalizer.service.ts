import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';

export interface RawSignalInput {
  title: string;
  summary?: string;
  rawContent?: string;
  category: string;
  sourceName: string;
  sourceKind?: string;
  sourceUrl?: string;
  severity?: string;
  confidence?: string;
  impactHorizon?: string;
  geographicZones?: string[];
  countries?: string[];
  affectedSectors?: string[];
  affectedCurrencies?: string[];
  affectedAssetClasses?: string[];
  occurredAt?: string;
  references?: string[];
  tags?: string[];
}

// Maps free-text categories to canonical values
const CATEGORY_ALIASES: Record<string, string> = {
  'fed_rate': 'central_bank_decision',
  'fed rate': 'central_bank_decision',
  'ecb': 'central_bank_decision',
  'rate_decision': 'central_bank_decision',
  'rate decision': 'central_bank_decision',
  'cpi': 'inflation_data',
  'ppi': 'inflation_data',
  'inflation': 'inflation_data',
  'gdp': 'growth_data',
  'pmi': 'growth_data',
  'unemployment': 'employment_data',
  'jobs': 'employment_data',
  'nfp': 'employment_data',
  'usd': 'fx_move',
  'eur': 'fx_move',
  'forex': 'fx_move',
  'oil': 'commodity_move',
  'gold': 'commodity_move',
  'gas': 'commodity_move',
  'geopolitics': 'geopolitical_tension',
  'conflict': 'geopolitical_tension',
  'war': 'geopolitical_tension',
  'sanctions': 'geopolitical_tension',
  'election': 'election_event',
  'regulation': 'regulatory_change',
  'law': 'regulatory_change',
  'volatility': 'market_stress',
  'vix': 'market_stress',
  'liquidity': 'market_stress',
  'default': 'credit_event',
};

const VALID_CATEGORIES = [
  'central_bank_decision','inflation_data','growth_data','employment_data',
  'fx_move','commodity_move','geopolitical_tension','election_event',
  'regulatory_change','market_stress','earnings_surprise','credit_event',
];

const VALID_SEVERITIES = ['info','watch','warning','critical','systemic'];
const VALID_CONFIDENCES = ['low','medium','high'];
const VALID_HORIZONS = ['immediate','short_term','medium_term','long_term'];

function coerce(value: string | undefined, validValues: string[], fallback: string): string {
  if (!value) return fallback;
  const lower = value.toLowerCase().replace(/[^a-z_]/g, '_');
  if (validValues.includes(lower)) return lower;
  // Try alias lookup
  for (const [alias, canonical] of Object.entries(CATEGORY_ALIASES)) {
    if (lower.includes(alias)) return canonical;
  }
  return fallback;
}

function normalizeCategory(raw: string): string {
  const lower = raw.toLowerCase().replace(/[^a-z_]/g, '_');
  if (VALID_CATEGORIES.includes(lower)) return lower;
  for (const [alias, canonical] of Object.entries(CATEGORY_ALIASES)) {
    if (lower.includes(alias)) return canonical;
  }
  return 'market_stress'; // safe fallback
}

@Injectable()
export class SignalNormalizerService {
  normalize(input: RawSignalInput) {
    return {
      id: uuid(),
      category: normalizeCategory(input.category),
      status: 'ingested' as const,
      title: input.title.trim().slice(0, 500),
      summary: (input.summary ?? '').trim().slice(0, 5000),
      rawContent: input.rawContent ?? null,
      source: {
        kind: (input.sourceKind ?? 'manual') as 'manual' | 'rss' | 'webhook' | 'api' | 'user_input',
        name: input.sourceName,
        url: input.sourceUrl ?? null,
        reliabilityScore: null,
      },
      severity: coerce(input.severity, VALID_SEVERITIES, 'info') as 'info' | 'watch' | 'warning' | 'critical' | 'systemic',
      confidence: coerce(input.confidence, VALID_CONFIDENCES, 'medium') as 'low' | 'medium' | 'high',
      impactHorizon: coerce(input.impactHorizon, VALID_HORIZONS, 'short_term') as 'immediate' | 'short_term' | 'medium_term' | 'long_term',
      geographicZones: input.geographicZones ?? [],
      countries: input.countries ?? [],
      affectedSectors: input.affectedSectors ?? [],
      affectedCurrencies: input.affectedCurrencies ?? [],
      affectedAssetClasses: input.affectedAssetClasses ?? [],
      references: input.references ?? [],
      tags: input.tags ?? [],
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      ingestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}
