/**
 * P19β (30/04/2026) — Tests pour shadow-logging mode strict 6/6.
 *
 * Cf. Issue #128 "Gainers 6/6 strict operational test" + CLAUDE.md.
 *
 * Activation : `gainers_min_persistence_score >= 0.999` sur le portfolio.
 * Ratios (avec tolérance float pour 5/6=0.8333 et 4/6=0.6667) :
 *   1.00 (6/6)         → ouverture normale (pass aux gates suivants)
 *   [0.83, 1.0)  5/6   → log `gainer_shadow_566` + skip
 *   [0.66, 0.83) 4/6   → log `gainer_shadow_466` + skip
 *   < 0.66             → skip silencieux
 *
 * Mode standard (minScore=0.67) : aucun shadow log émis (le code skip
 * complètement le bloc shadow car `minScore < STRICT_MODE_THRESHOLD`).
 */

import { Logger } from '@nestjs/common';
import { TopGainersScannerService } from '../services/top-gainers-scanner.service';

// ── Stubs ────────────────────────────────────────────────────────────────────

const supabaseFromMock = jest.fn();
const mockSupabase = { getClient: () => ({ from: supabaseFromMock }) } as any;

// PR #250 — Scanner appelle désormais paperBroker.openPositionDirect via
// lisa.getPaperBroker() (bypass approveProposal/pipeline LLM).
const mockOpenPositionDirect = jest.fn().mockResolvedValue({
  id: 'mock-pos-id',
  portfolioId: 'mock',
  symbol: 'MOCK',
  quantity: '1',
  entryPrice: '100',
});
const mockPaperBroker = { openPositionDirect: mockOpenPositionDirect } as any;
const mockLisa = {
  approveProposal: jest.fn().mockResolvedValue({ openedPositions: [] }),
  getPaperBroker: () => mockPaperBroker,
  getLivePrice: jest.fn().mockResolvedValue({
    symbol: 'MOCK', price: '100', asOf: new Date().toISOString(), source: 'eodhd',
  }),
} as any;
const decisionLogAppend = jest.fn().mockResolvedValue(undefined);
const mockDecisionLog = { append: decisionLogAppend } as any;
const mockConfig = { get: jest.fn() } as any;
const mockBinance = { getTicker24h: jest.fn().mockResolvedValue(null) } as any;
const mockScheduler = {
  getCronJob: jest.fn().mockImplementation(() => { throw new Error('not found'); }),
  addCronJob: jest.fn(),
} as any;
const mockMtf = { analyzeBatch: jest.fn() } as any;
const mockLlmRouter = { isEnabled: jest.fn().mockReturnValue(false), call: jest.fn() } as any;

const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

beforeEach(() => {
  decisionLogAppend.mockClear();
  mockLisa.approveProposal.mockClear();
  mockOpenPositionDirect.mockClear();
  mockLisa.getLivePrice.mockClear();
  logSpy.mockClear();
  supabaseFromMock.mockReset();
  mockMtf.analyzeBatch.mockReset();
});

function makeService(): TopGainersScannerService {
  mockConfig.get.mockImplementation((key: string) => {
    if (key === 'SCAN_INTERVAL_MINUTES') return '15';
    return undefined;
  });
  return new TopGainersScannerService(
    mockSupabase,
    mockLisa,
    mockDecisionLog,
    mockConfig,
    mockBinance,
    mockScheduler,
    mockMtf,
    mockLlmRouter,
    { isShadowEnabled: () => false } as any, { evaluate: () => ({ raw: {} as any, compositeScore: null, decision: "REJECT", rejectReason: null, spreadProxy: null, spreadProxySource: null, trendFilter: null, rvolIntraday: null }) } as any,
    { estimateProbability: async () => ({ pWin: 0.5, confidence: 0, sampleSize: 0, modelVersion: "none", fallback: true }) } as any,
  );
}

/**
 * Mock the Supabase chains called in `scanPortfolio()` :
 *
 * - `lisa_positions` est appelé par 3 chaînes différentes (watchdog,
 *   openPositions, cooldown). On utilise un proxy chain qui implémente
 *   toutes les méthodes et résout à `[]` pour tous les await.
 *
 * - `lisa_session_configs` retourne le row config avec
 *   `gainers_min_persistence_score` configurable (1.0 strict / 0.67 standard).
 *
 * - `lisa_proposals` (insert pour ouverture) retourne success.
 */
function mockSupabaseFor(minPersistenceScore: number | null) {
  supabaseFromMock.mockImplementation((table: string) => {
    if (table === 'lisa_positions') {
      const result = { data: [], error: null };
      const chain: any = {};
      const methods = ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'limit', 'maybeSingle', 'insert', 'update'];
      for (const m of methods) chain[m] = jest.fn().mockReturnValue(chain);
      chain.then = (resolve: any) => resolve(result);
      return chain;
    }
    if (table === 'lisa_session_configs') {
      const cfgRow = {
        gainers_min_persistence_score: minPersistenceScore,
        gainers_min_path_efficiency: null,
        gainers_default_tp_pct: 1.5,
        gainers_default_sl_pct: 1.0,
      };
      const maybeSingle = jest.fn().mockResolvedValue({ data: cfgRow, error: null });
      const eq = jest.fn().mockReturnValue({ maybeSingle });
      const select = jest.fn().mockReturnValue({ eq });
      return { select };
    }
    if (table === 'lisa_proposals') {
      return { insert: jest.fn().mockResolvedValue({ error: null }) };
    }
    return { select: jest.fn() };
  });
}

function makeCandidate(symbol: string) {
  return {
    symbol,
    exchange: 'US',
    close: 100,
    high: 105,
    changePct: 5,
    volume: 1_000_000,
    avgVol50d: 500_000,
    marketCap: 1e10,
    score: 0.7,
    assetClass: 'us_equity_large' as const,
  };
}

function makePersistence(score: number, count: string) {
  return {
    persistenceScore: score,
    persistenceCount: count,
    availableCount: 6,
    tf1m: 0.01,
    tf5m: 0.02,
    tf10m: 0.03,
    tf15m: 0.04,
    tf30m: 0.05,
    tf1h: 0.06,
    pathQuality: { overallEfficiency: 0.8, overallSmoothness: 'smooth' as const },
  };
}

const PORTFOLIO_ID = '11111111-1111-1111-1111-111111111111';

describe('TopGainersScanner — P19β shadow-logging strict 6/6', () => {
  // ── Cas 1 — strict 6/6 + score=1.0 → pas de shadow log, pipeline poursuit ──

  it('persistenceScore=1.00 (6/6) : pas de shadow log, pipeline poursuit (approveProposal appelé)', async () => {
    mockSupabaseFor(1.0);
    mockMtf.analyzeBatch.mockResolvedValue(new Map([
      ['SYM6', makePersistence(1.0, '6/6')],
    ]));

    const svc = makeService();
    await (svc as any).scanPortfolio('user-1', PORTFOLIO_ID, [makeCandidate('SYM6')]);

    // Aucun shadow log
    const shadowCalls = decisionLogAppend.mock.calls.filter(
      (c) => c[0]?.kind === 'gainer_shadow_566' || c[0]?.kind === 'gainer_shadow_466',
    );
    expect(shadowCalls.length).toBe(0);

    // Aucun skip log "persistenceScore < min" pour SYM6 (le gate persistence
    // a passé)
    const persistenceSkipLogs = logSpy.mock.calls.filter((c) =>
      String(c[0]).includes('SYM6') && /persistenceScore=.+ < min=/.test(String(c[0])),
    );
    expect(persistenceSkipLogs.length).toBe(0);

    // approveProposal a été appelé (le pipeline a tenté d'ouvrir)
    expect(mockOpenPositionDirect).toHaveBeenCalled();
  });

  // ── Cas 2 — strict 6/6 + score=0.83 → gainer_shadow_566 + skip ────────────

  it('persistenceScore=0.83 (5/6) : log gainer_shadow_566 + skip ouverture', async () => {
    mockSupabaseFor(1.0);
    mockMtf.analyzeBatch.mockResolvedValue(new Map([
      ['SYM5', makePersistence(0.8333333, '5/6')],
    ]));

    const svc = makeService();
    await (svc as any).scanPortfolio('user-1', PORTFOLIO_ID, [makeCandidate('SYM5')]);

    const shadow566 = decisionLogAppend.mock.calls.filter(
      (c) => c[0]?.kind === 'gainer_shadow_566',
    );
    expect(shadow566.length).toBe(1);
    const call = shadow566[0][0];
    expect(call.summary).toContain('SYM5');
    expect(call.summary).toContain('5/6');
    expect(call.payload).toMatchObject({
      symbol: 'SYM5',
      persistenceScore: 0.8333333,
      persistenceCount: '5/6',
    });
    expect(call.triggeredBy).toBe('autopilot_cron');

    const shadow466 = decisionLogAppend.mock.calls.filter(
      (c) => c[0]?.kind === 'gainer_shadow_466',
    );
    expect(shadow466.length).toBe(0);

    // approveProposal NON appelé : skip ouverture
    expect(mockOpenPositionDirect).not.toHaveBeenCalled();
  });

  // ── Cas 3 — strict 6/6 + score=0.6667 (4/6) → gainer_shadow_466 + skip ────

  it('persistenceScore=0.6667 (4/6) : log gainer_shadow_466 + skip ouverture', async () => {
    mockSupabaseFor(1.0);
    mockMtf.analyzeBatch.mockResolvedValue(new Map([
      ['SYM4', makePersistence(0.6666667, '4/6')],
    ]));

    const svc = makeService();
    await (svc as any).scanPortfolio('user-1', PORTFOLIO_ID, [makeCandidate('SYM4')]);

    const shadow466 = decisionLogAppend.mock.calls.filter(
      (c) => c[0]?.kind === 'gainer_shadow_466',
    );
    expect(shadow466.length).toBe(1);
    const call = shadow466[0][0];
    expect(call.summary).toContain('SYM4');
    expect(call.summary).toContain('4/6');
    expect(call.payload).toMatchObject({
      symbol: 'SYM4',
      persistenceCount: '4/6',
    });

    const shadow566 = decisionLogAppend.mock.calls.filter(
      (c) => c[0]?.kind === 'gainer_shadow_566',
    );
    expect(shadow566.length).toBe(0);

    // Skip ouverture
    expect(mockOpenPositionDirect).not.toHaveBeenCalled();
  });

  // ── Cas 4 — strict 6/6 + score=0.5 (3/6) → silent skip ─────────────────────

  it('persistenceScore=0.50 (3/6) : pas de log, skip silencieux', async () => {
    mockSupabaseFor(1.0);
    mockMtf.analyzeBatch.mockResolvedValue(new Map([
      ['SYM3', makePersistence(0.5, '3/6')],
    ]));

    const svc = makeService();
    await (svc as any).scanPortfolio('user-1', PORTFOLIO_ID, [makeCandidate('SYM3')]);

    const shadowCalls = decisionLogAppend.mock.calls.filter(
      (c) => c[0]?.kind === 'gainer_shadow_566' || c[0]?.kind === 'gainer_shadow_466',
    );
    expect(shadowCalls.length).toBe(0);

    // Skip ouverture
    expect(mockOpenPositionDirect).not.toHaveBeenCalled();
  });

  // ── Cas 5 — mode standard (minScore=0.67) : aucun shadow log même sur 5/6 ──

  it('mode standard (minScore=0.67) : aucun shadow log émis (5/6 passe gate normalement)', async () => {
    mockSupabaseFor(0.67);
    mockMtf.analyzeBatch.mockResolvedValue(new Map([
      ['SYM5', makePersistence(0.8333333, '5/6')],
    ]));

    const svc = makeService();
    await (svc as any).scanPortfolio('user-1', PORTFOLIO_ID, [makeCandidate('SYM5')]);

    const shadowCalls = decisionLogAppend.mock.calls.filter(
      (c) => c[0]?.kind === 'gainer_shadow_566' || c[0]?.kind === 'gainer_shadow_466',
    );
    expect(shadowCalls.length).toBe(0);

    // 5/6=0.8333 >= 0.67 → persistence gate passe → pipeline poursuit jusqu'à
    // approveProposal
    expect(mockOpenPositionDirect).toHaveBeenCalled();
  });
});
