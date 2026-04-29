/**
 * P13 hotfix — regression test for "Cannot create property 'assetClass' on string"
 *
 * Bug : quand Claude retourne expressions/poolsScan.favored/avoided comme
 * array de strings (au lieu d'array d'objets), le code de normalisation
 * essayait `e.assetClass = ...` sur une string et crashait.
 *
 * Le fix : guard runtime `typeof e === 'object' && !Array.isArray(e)` avant
 * d'écrire la propriété.
 */
import { ThesisGeneratorService } from '../thesis-generator.service';

// Accède à la méthode privée normalizeProposal via cast pour tester en isolation.
// Pas idéal côté style mais évite un refactor intrusif sur un hotfix.
type NormalizeProposalFn = (
  parsed: unknown,
  config: unknown,
  claudeResult: { model: string; usage: { inputTokens: number; outputTokens: number } },
) => unknown;

function getNormalize(): NormalizeProposalFn {
  // Constructor needs claudeClient + corpus, mais normalizeProposal n'utilise
  // ni l'un ni l'autre — on passe des stubs vides.
  const svc = new ThesisGeneratorService({} as never, {} as never);
  return ((svc as unknown as { normalizeProposal: NormalizeProposalFn }).normalizeProposal).bind(svc);
}

const baseConfig = {
  capitalUsd: '10000',
  baseCurrency: 'USD',
  profile: 'active_trading',
  antiConsensusStrength: 5,
  maxTheses: 3,
  enableCrypto: true,
  enableDerivatives: false,
  enableLeverage: false,
  riskConstraints: {
    maxDrawdown2DaysPct: 5,
    maxDrawdown7DaysPct: 10,
    maxOpenPositions: 3,
    maxExposurePerAssetClassPct: 40,
  },
};

const claudeMeta = { model: 'claude-opus-4-7', usage: { inputTokens: 1, outputTokens: 1 } };

describe('normalizeProposal — defensive parsing of malformed Claude output (P13 hotfix)', () => {
  it('does NOT crash when expressions is array of strings (the bug)', () => {
    const normalize = getNormalize();
    const malformed = {
      theses: [
        {
          id: 't1',
          title: 'Stagflation hedge',
          expressions: ['confidenceScore', 'assetClass'], // strings au lieu d'objets
        },
      ],
      poolsScan: { favored: [], avoided: [] },
      allocationSuggestion: { perThesis: [], cashReservePct: 100 },
      marketContext: { regime: 'stagflation' },
    };
    expect(() => normalize(malformed, baseConfig, claudeMeta)).not.toThrow(
      /Cannot create property/,
    );
  });

  it('does NOT crash when poolsScan.favored is array of strings', () => {
    const normalize = getNormalize();
    const malformed = {
      theses: [],
      poolsScan: {
        favored: ['confidenceScore', 'rationale'], // strings au lieu d'objets
        avoided: [],
      },
      allocationSuggestion: { perThesis: [], cashReservePct: 100 },
      marketContext: { regime: 'stagflation' },
    };
    expect(() => normalize(malformed, baseConfig, claudeMeta)).not.toThrow(
      /Cannot create property/,
    );
  });

  it('does NOT crash when poolsScan.avoided is array of strings', () => {
    const normalize = getNormalize();
    const malformed = {
      theses: [],
      poolsScan: {
        favored: [],
        avoided: ['rationale'],
      },
      allocationSuggestion: { perThesis: [], cashReservePct: 100 },
      marketContext: { regime: 'stagflation' },
    };
    expect(() => normalize(malformed, baseConfig, claudeMeta)).not.toThrow(
      /Cannot create property/,
    );
  });

  it('does NOT crash when expressions contains a mix of objects and strings', () => {
    const normalize = getNormalize();
    const malformed = {
      theses: [
        {
          id: 't1',
          title: 'Mixed',
          expressions: [
            { symbol: 'GLD', assetClass: 'gold' },
            'confidenceScore', // intrus
            { symbol: 'TLT', assetClass: 'bonds' },
          ],
        },
      ],
      poolsScan: { favored: [], avoided: [] },
      allocationSuggestion: { perThesis: [], cashReservePct: 100 },
      marketContext: { regime: 'stagflation' },
    };
    expect(() => normalize(malformed, baseConfig, claudeMeta)).not.toThrow(
      /Cannot create property/,
    );
  });

  it('does NOT crash with TypeError when expressions contains null', () => {
    const normalize = getNormalize();
    const malformed = {
      theses: [
        {
          id: 't1',
          title: 'Null guard',
          expressions: [null, { symbol: 'GLD', assetClass: 'gold' }],
        },
      ],
      poolsScan: { favored: [null, null], avoided: [] },
      allocationSuggestion: { perThesis: [], cashReservePct: 100 },
      marketContext: { regime: 'stagflation' },
    };
    // Le bug original (Cannot create property) ne doit PAS apparaître.
    // Une éventuelle Zod failure downstream sur la thèse incomplète est OK.
    expect(() => normalize(malformed, baseConfig, claudeMeta)).not.toThrow(
      /Cannot create property/,
    );
  });

  it('filters out non-object pools from favoredPockets/avoidedPockets', () => {
    const normalize = getNormalize();
    const malformed = {
      theses: [], // pas de thèses → pas de Zod validation à passer
      poolsScan: {
        favored: [
          { assetClass: 'commodities_metals_precious', rationale: 'gold' },
          'confidenceScore', // string filtrée (le bug)
          null,
          { assetClass: 'govt_bonds_us', rationale: 'flight to safety' },
        ],
        avoided: ['rationale', { assetClass: 'crypto_altcoins', rationale: 'avoid' }],
      },
      allocationSuggestion: { perThesis: [], cashReservePct: 100 },
      marketContext: { regime: 'stagflation' },
    };
    const result = normalize(malformed, baseConfig, claudeMeta) as {
      favoredPockets: Array<{ assetClass: string }>;
      avoidedPockets: Array<{ assetClass: string }>;
    };
    expect(result.favoredPockets).toHaveLength(2);
    expect(result.favoredPockets[0].assetClass).toBe('commodities_metals_precious');
    expect(result.favoredPockets[1].assetClass).toBe('govt_bonds_us');
    expect(result.avoidedPockets).toHaveLength(1);
    expect(result.avoidedPockets[0].assetClass).toBe('crypto_altcoins');
  });
});
