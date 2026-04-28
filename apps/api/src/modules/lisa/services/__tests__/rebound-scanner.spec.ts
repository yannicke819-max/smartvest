/**
 * P3-A.2 — Tests pour ReboundScannerService.
 *
 * Mocks pragmatiques (supabase chained API + LisaService + ConfigService).
 * Couvre :
 *   - DAILY_TARGET_HIT bloque tout scan
 *   - MAX_CONCURRENT_REBOUND_POSITIONS respecté
 *   - duplicate guard sur (portfolio_id, ticker) OPEN
 *   - mock provider history → INSERT correct sur signal BUY
 *   - HOLD signal → no INSERT
 */
import { ReboundScannerService } from '../rebound-scanner.service';

// ── Helpers : factories pour fixtures de bougies ─────────────────────

function buyFixture() {
  // Setup capitulation reproduit du spec scanRebound (PR #43).
  const closes = [
    100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
    100, 100, 100, 100, 100, 100,
    92, 88, 82, 85,
  ];
  return closes.map((close, i) => {
    const open = i === 0 ? close * 0.999 : closes[i - 1];
    return {
      timestamp: i,
      open,
      high: Math.max(open, close) * 1.005,
      low: Math.min(open, close) * 0.995,
      close,
      volume: i === closes.length - 1 ? 3500 : 1000,
    };
  });
}

function holdFixture() {
  // Trend bull stable → RSI > 30 → HOLD
  const bars = [];
  for (let i = 0; i < 30; i++) {
    const close = 100 + i * 0.5;
    bars.push({ timestamp: i, open: close, high: close * 1.003, low: close * 0.997, close, volume: 1000 });
  }
  return bars;
}

// ── Mock supabase chainable API ──────────────────────────────────────

interface MockState {
  configs: Array<{ user_id: string; portfolio_id: string }>;
  openPositions: Array<{ ticker: string }>;
  /** Tracker des INSERT effectués sur rebound_positions */
  inserts: Array<Record<string, unknown>>;
  /** Si true, le double-check insert (select before insert) trouve la row */
  insertConflict: boolean;
}

function makeSupabaseMock(state: MockState) {
  const fromBuilder = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.like = () => chain;
    chain.gte = () => chain;
    chain.lt = () => chain;
    chain.not = () => chain;
    chain.in = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.maybeSingle = async () => {
      if (table === 'rebound_positions' && state.insertConflict) {
        return { data: { id: 'existing-row' }, error: null };
      }
      return { data: null, error: null };
    };
    chain.insert = async (row: Record<string, unknown>) => {
      if (table === 'rebound_positions') {
        state.inserts.push(row);
      }
      return { data: null, error: null };
    };
    chain.update = async () => ({ data: null, error: null });
    // For `.then()`-able promise (e.g., `.from('x').select(...)` awaited directly)
    (chain as { then: (resolve: (v: { data: unknown; error: null }) => void) => void }).then = (
      resolve,
    ) => {
      if (table === 'lisa_session_configs') {
        resolve({ data: state.configs, error: null });
      } else if (table === 'rebound_positions') {
        resolve({ data: state.openPositions, error: null });
      } else {
        resolve({ data: [], error: null });
      }
    };
    return chain;
  };

  return {
    getClient: () => ({
      from: (table: string) => fromBuilder(table),
    }),
  };
}

// ── Mock LisaService ─────────────────────────────────────────────────

function makeLisaMock(opts: { dailyTargetHit?: boolean }) {
  return {
    getDailyPnl: jest.fn(async () => ({
      realized: 0,
      latent: 0,
      target: 100,
      achievementPct: 0,
      drift: -100,
      dailyTargetHit: opts.dailyTargetHit ?? false,
    })),
  };
}

// ── Mock DecisionLogService ──────────────────────────────────────────

function makeDecisionLogMock() {
  return { append: jest.fn(async () => ({ id: 'log-id', hashChainCurrent: 'h', hashChainPrev: null })) };
}

// ── Mock ConfigService (key/value) ───────────────────────────────────

function makeConfigMock(env: Record<string, string>) {
  return { get: jest.fn((key: string) => env[key]) };
}

// ── Helper : construit le scanner avec stubs ─────────────────────────

function buildScanner(opts: {
  state: MockState;
  dailyTargetHit?: boolean;
  env?: Record<string, string>;
  barsByTicker?: Record<string, ReturnType<typeof buyFixture> | null>;
}): ReboundScannerService {
  const supabase = makeSupabaseMock(opts.state);
  const lisa = makeLisaMock({ ...(opts.dailyTargetHit !== undefined ? { dailyTargetHit: opts.dailyTargetHit } : {}) });
  const decisionLog = makeDecisionLogMock();
  const config = makeConfigMock({
    EODHD_API_KEY: 'test-key',
    REBOUND_WATCHLIST: 'AAPL.US',
    ...(opts.env ?? {}),
  });
  // P3-C : OhlcvCacheService mock minimal — phase 1 lit getCachedBars,
  // dispatch reads getActiveUniverse. On stube les deux pour retourner
  // les bars de buyFixture (passe le pre-filter RSI) et la watchlist
  // depuis l'env CSV.
  const ohlcvCache = {
    getCachedBars: jest.fn(async (ticker: string) => {
      const k = ticker.split('.')[0] + '.US';
      return opts.barsByTicker?.[k] ?? opts.barsByTicker?.[ticker] ?? buyFixture();
    }),
    getActiveUniverse: jest.fn(async () => {
      const csv = opts.env?.REBOUND_WATCHLIST ?? 'AAPL.US';
      return csv.split(',').map((t) => t.trim()).filter(Boolean);
    }),
  };
  const scanner = new ReboundScannerService(
    supabase as never,
    lisa as never,
    decisionLog as never,
    config as never,
    ohlcvCache as never,
  );
  // Override fetch via getDailyBars : on patche la méthode privée pour
  // retourner un fixture déterministe sans appel réseau.
  (scanner as unknown as { getDailyBars: (t: string) => Promise<unknown> }).getDailyBars = async (
    ticker: string,
  ) => {
    const k = ticker.split('.')[0] + '.US';
    return opts.barsByTicker?.[k] ?? opts.barsByTicker?.[ticker] ?? buyFixture();
  };
  return scanner;
}

describe('ReboundScannerService', () => {
  describe('runScannerInner', () => {
    it('skips scan when dailyTargetHit=true (audit recorded, no INSERT)', async () => {
      const state: MockState = {
        configs: [{ user_id: 'u1', portfolio_id: 'p1' }],
        openPositions: [],
        inserts: [],
        insertConflict: false,
      };
      const scanner = buildScanner({ state, dailyTargetHit: true });
      // @ts-expect-error access private
      await scanner.runScannerInner();
      expect(state.inserts).toHaveLength(0);
    });

    it('skips scan when openCount >= MAX_CONCURRENT_REBOUND_POSITIONS', async () => {
      const state: MockState = {
        configs: [{ user_id: 'u1', portfolio_id: 'p1' }],
        openPositions: [
          { ticker: 'A' },
          { ticker: 'B' },
          { ticker: 'C' },
        ],
        inserts: [],
        insertConflict: false,
      };
      const scanner = buildScanner({
        state,
        env: { MAX_CONCURRENT_REBOUND_POSITIONS: '3', REBOUND_WATCHLIST: 'AAPL.US' },
      });
      // @ts-expect-error access private
      await scanner.runScannerInner();
      expect(state.inserts).toHaveLength(0);
    });

    it('inserts rebound_positions on BUY signal (mock provider history)', async () => {
      const state: MockState = {
        configs: [{ user_id: 'u1', portfolio_id: 'p1' }],
        openPositions: [],
        inserts: [],
        insertConflict: false,
      };
      const scanner = buildScanner({
        state,
        env: { REBOUND_WATCHLIST: 'AAPL.US', MAX_CONCURRENT_REBOUND_POSITIONS: '5' },
      });
      // @ts-expect-error access private
      await scanner.runScannerInner();
      expect(state.inserts).toHaveLength(1);
      const insert = state.inserts[0];
      expect(insert.portfolio_id).toBe('p1');
      expect(insert.ticker).toBe('AAPL');
      expect(insert.status).toBe('OPEN');
      expect(parseFloat(insert.entry_price as string)).toBe(85);
      expect(parseFloat(insert.tp1 as string)).toBe(89.25);
      expect(parseFloat(insert.sl as string)).toBe(81.6);
    });

    it('does NOT insert on HOLD signal', async () => {
      const state: MockState = {
        configs: [{ user_id: 'u1', portfolio_id: 'p1' }],
        openPositions: [],
        inserts: [],
        insertConflict: false,
      };
      const scanner = buildScanner({
        state,
        barsByTicker: { 'AAPL.US': holdFixture() as never },
        env: { REBOUND_WATCHLIST: 'AAPL.US' },
      });
      // @ts-expect-error access private
      await scanner.runScannerInner();
      expect(state.inserts).toHaveLength(0);
    });

    it('duplicate guard : second scan with existing OPEN does not insert', async () => {
      const state: MockState = {
        configs: [{ user_id: 'u1', portfolio_id: 'p1' }],
        openPositions: [{ ticker: 'AAPL' }], // déjà OPEN
        inserts: [],
        insertConflict: false,
      };
      const scanner = buildScanner({
        state,
        env: { REBOUND_WATCHLIST: 'AAPL.US' },
      });
      // @ts-expect-error access private
      await scanner.runScannerInner();
      expect(state.inserts).toHaveLength(0);
    });

    it('race-condition guard : insertConflict prevents double insert', async () => {
      const state: MockState = {
        configs: [{ user_id: 'u1', portfolio_id: 'p1' }],
        openPositions: [], // openPositions empty mais le SELECT-before-INSERT trouve une row
        inserts: [],
        insertConflict: true,
      };
      const scanner = buildScanner({
        state,
        env: { REBOUND_WATCHLIST: 'AAPL.US' },
      });
      // @ts-expect-error access private
      await scanner.runScannerInner();
      expect(state.inserts).toHaveLength(0);
    });
  });

  describe('config helpers', () => {
    it('parses REBOUND_WATCHLIST CSV', async () => {
      const state: MockState = { configs: [], openPositions: [], inserts: [], insertConflict: false };
      const scanner = buildScanner({
        state,
        env: { REBOUND_WATCHLIST: 'AAPL.US, MSFT.US , NVDA.US' },
      });
      // @ts-expect-error access private
      const wl = scanner.getWatchlist();
      expect(wl).toEqual(['AAPL.US', 'MSFT.US', 'NVDA.US']);
    });

    it('falls back to default watchlist when REBOUND_WATCHLIST empty', async () => {
      const state: MockState = { configs: [], openPositions: [], inserts: [], insertConflict: false };
      const scanner = buildScanner({ state, env: { REBOUND_WATCHLIST: '' } });
      // @ts-expect-error access private
      const wl = scanner.getWatchlist();
      expect(wl.length).toBeGreaterThan(0);
      expect(wl).toContain('AAPL.US');
    });

    it('uses MAX_CONCURRENT_REBOUND_POSITIONS env (default 3 if unset, P3-D)', async () => {
      const state: MockState = { configs: [], openPositions: [], inserts: [], insertConflict: false };
      const scanner1 = buildScanner({ state, env: {} });
      // @ts-expect-error access private
      expect(scanner1.getMaxConcurrent()).toBe(3);

      const scanner2 = buildScanner({ state, env: { MAX_CONCURRENT_REBOUND_POSITIONS: '8' } });
      // @ts-expect-error access private
      expect(scanner2.getMaxConcurrent()).toBe(8);
    });
  });
});
