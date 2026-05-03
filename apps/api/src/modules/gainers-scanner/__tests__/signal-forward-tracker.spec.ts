/**
 * PR6.8 RCFT — SignalForwardTrackerService specs.
 *
 * Validation core :
 *  - gateBeforeReject mapping correct
 *  - Skip equity weekend rejects (sat/sun)
 *  - Outcome computation : champion / failure / neutral
 *  - Cron boote sans erreur (boot smoke test couvre déjà)
 */

import { SignalForwardTrackerService } from '../automations/signal-forward-tracker.service';

function makeMockSupabase() {
  const calls: Array<{ table: string; op: string; payload?: any }> = [];
  const rowsByQuery: any[] = [];

  const builder = (tableName: string): any => {
    let _filters: any[] = [];
    let _op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' | null = null;
    let _payload: any = null;
    let _isClause: { col: string; val: any } | null = null;
    let _notClause: { col: string; val: any } | null = null;

    const obj: any = {
      select() { _op = _op ?? 'select'; return obj; },
      insert(p: any) { _op = 'insert'; _payload = p; calls.push({ table: tableName, op: 'insert', payload: p }); return obj; },
      upsert(p: any) { _op = 'upsert'; _payload = p; calls.push({ table: tableName, op: 'upsert', payload: p }); return Promise.resolve({ error: null }); },
      update(p: any) { _op = 'update'; _payload = p; return obj; },
      delete(opts?: any) { _op = 'delete'; void opts; return obj; },
      eq(col: string, val: any) { _filters.push({ col, val, op: 'eq' }); return obj; },
      gte() { return obj; },
      lte() { return obj; },
      lt() { return obj; },
      is(col: string, val: any) { _isClause = { col, val }; return obj; },
      not(col: string, _op: string, val: any) { _notClause = { col, val }; return obj; },
      limit() {
        if (_op === 'select') {
          return Promise.resolve({ data: rowsByQuery.shift() ?? [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: any) {
        if (_op === 'update') {
          calls.push({ table: tableName, op: 'update', payload: _payload });
          return resolve({ data: null, error: null });
        }
        if (_op === 'delete') {
          calls.push({ table: tableName, op: 'delete' });
          return resolve({ data: null, error: null, count: 0 });
        }
        return resolve({ data: rowsByQuery.shift() ?? [], error: null });
      },
    };
    return obj;
  };

  return {
    getClient: () => ({ from: (t: string) => builder(t) }),
    _calls: calls,
    _setRows: (rows: any[]) => { rowsByQuery.push(rows); },
  } as any;
}

function makeMockBinance() {
  return {
    getKlines: jest.fn(async (sym: string, interval: string, count: number) => {
      void interval; void count;
      const baseClose = sym === 'BTCUSDT' ? 60000 : 100;
      return Array.from({ length: 5 }, (_, i) => ({
        openTime: Date.now() - (4 - i) * 86400_000,
        close: baseClose * (1 + i * 0.01),
        open: baseClose,
        high: baseClose * 1.02,
        low: baseClose * 0.98,
        volume: 1000,
      }));
    }),
  } as any;
}

function makeMockEodhd() {
  return {
    getCandles: jest.fn(async () => ({
      candles: [{ open: 100, high: 105, low: 95, close: 102, volume: 1000, timestamp: Date.now() }],
    })),
  } as any;
}

function makeMockInsights() {
  return {
    logInsight: jest.fn(async () => 'mock-id'),
  } as any;
}

function makeMockConfig(envTag = 'shadow') {
  return {
    get: (key: string) => key === 'GAINERS_ENV_TAG' ? envTag : undefined,
  } as any;
}

describe('SignalForwardTrackerService', () => {
  it('boots without error and uses GAINERS_ENV_TAG (default shadow)', () => {
    const svc = new SignalForwardTrackerService(
      makeMockSupabase(),
      makeMockBinance(),
      makeMockEodhd(),
      makeMockInsights(),
      makeMockConfig('shadow'),
    );
    expect(svc).toBeTruthy();
  });

  it('reads env_tag from config (canary override)', () => {
    const svc = new SignalForwardTrackerService(
      makeMockSupabase(),
      makeMockBinance(),
      makeMockEodhd(),
      makeMockInsights(),
      makeMockConfig('canary'),
    );
    // private field — verify via runInner side-effect (seed with env_tag='canary')
    expect((svc as any).envTag).toBe('canary');
  });

  it('falls back to shadow if env_tag invalid', () => {
    const svc = new SignalForwardTrackerService(
      makeMockSupabase(),
      makeMockBinance(),
      makeMockEodhd(),
      makeMockInsights(),
      makeMockConfig('invalid_value'),
    );
    expect((svc as any).envTag).toBe('shadow');
  });

  // PR6.8.1 — Default env_tag regression check
  it('default env_tag stays "shadow" when GAINERS_ENV_TAG unset', () => {
    const config = { get: () => undefined } as any;
    const svc = new SignalForwardTrackerService(
      makeMockSupabase(),
      makeMockBinance(),
      makeMockEodhd(),
      makeMockInsights(),
      config,
    );
    expect((svc as any).envTag).toBe('shadow');
  });

  // PR6.8.1 — resolveEnvTag hook callable, returns process-level envTag today
  it('resolveEnvTag returns process-level envTag (canary-ready hook)', () => {
    const svc = new SignalForwardTrackerService(
      makeMockSupabase(),
      makeMockBinance(),
      makeMockEodhd(),
      makeMockInsights(),
      makeMockConfig('canary'),
    );
    const fakeRow = { id: 'x', symbol: 'BTCUSDT', asset_class: 'crypto', decision: 'REJECT',
      reject_reason: null, created_at: '2026-05-04T00:00:00Z', entry_price: 60000 };
    expect((svc as any).resolveEnvTag(fakeRow)).toBe('canary');
  });

  // PR6.8.1 — env vars override outcome thresholds at compute time
  it('resolveOutcomeThresholds uses env vars over row defaults', () => {
    const config = {
      get: (key: string) => {
        if (key === 'CHAMPION_RET_PCT') return '0.10';
        if (key === 'FAILURE_RET_PCT') return '-0.05';
        return undefined;
      },
    } as any;
    const svc = new SignalForwardTrackerService(
      makeMockSupabase(),
      makeMockBinance(),
      makeMockEodhd(),
      makeMockInsights(),
      config,
    );
    const result = (svc as any).resolveOutcomeThresholds(0.05, -0.02);
    expect(result.champion).toBe(0.10);  // env override
    expect(result.failure).toBe(-0.05);  // env override
  });

  it('resolveOutcomeThresholds falls back to row values when env unset', () => {
    const svc = new SignalForwardTrackerService(
      makeMockSupabase(),
      makeMockBinance(),
      makeMockEodhd(),
      makeMockInsights(),
      makeMockConfig(),
    );
    const result = (svc as any).resolveOutcomeThresholds(0.05, -0.02);
    expect(result.champion).toBe(0.05); // row default
    expect(result.failure).toBe(-0.02); // row default
  });

  it('skips equity weekend rejects (Saturday/Sunday)', () => {
    const svc = new SignalForwardTrackerService(
      makeMockSupabase(),
      makeMockBinance(),
      makeMockEodhd(),
      makeMockInsights(),
      makeMockConfig(),
    );
    const isSeedable = (svc as any).isSeedable.bind(svc);
    // Saturday 2026-05-02
    expect(isSeedable({ asset_class: 'equity', created_at: '2026-05-02T15:00:00Z' })).toBe(false);
    // Sunday 2026-05-03
    expect(isSeedable({ asset_class: 'equity', created_at: '2026-05-03T15:00:00Z' })).toBe(false);
    // Monday 2026-05-04
    expect(isSeedable({ asset_class: 'equity', created_at: '2026-05-04T15:00:00Z' })).toBe(true);
    // Crypto sat OK (24/7)
    expect(isSeedable({ asset_class: 'crypto', created_at: '2026-05-02T15:00:00Z' })).toBe(true);
  });
});

describe('gateBeforeReject mapping (PR6.8 ajout 3)', () => {
  // Re-import internal helper via service execution — covered by integration tests.
  // Quick sanity tests via mock seedNewSignals path.
  it('maps reject_reason correctly through service flow', async () => {
    const supabase = makeMockSupabase();
    // Seed query returns 3 sample rejects
    supabase._setRows([
      { id: 'r1', symbol: 'BTCUSDT', asset_class: 'crypto', decision: 'REJECT', reject_reason: 'LIQUIDITY_FLOOR', created_at: '2026-05-04T00:00:00Z', entry_price: 60000 },
      { id: 'r2', symbol: 'ETHUSDT', asset_class: 'crypto', decision: 'REJECT', reject_reason: 'PERSISTENCE_BELOW_THRESHOLD', created_at: '2026-05-04T00:00:00Z', entry_price: 3000 },
      { id: 'r3', symbol: 'SOLUSDT', asset_class: 'crypto', decision: 'ACCEPT', reject_reason: null, created_at: '2026-05-04T00:00:00Z', entry_price: 100 },
    ]);
    // Other queries return empty (T+24h, T+72h, outcomes, cleanup)
    supabase._setRows([]); // T+24h fetch
    supabase._setRows([]); // T+72h fetch
    supabase._setRows([]); // computeOutcomes
    const svc = new SignalForwardTrackerService(
      supabase,
      makeMockBinance(),
      makeMockEodhd(),
      makeMockInsights(),
      makeMockConfig(),
    );
    await svc.runInner();

    // Verify upsert called with correct gate_passed_until mapping
    const upsertCalls = supabase._calls.filter((c: any) => c.op === 'upsert');
    expect(upsertCalls.length).toBeGreaterThan(0);
    const payload = upsertCalls[0].payload;
    const r1 = payload.find((p: any) => p.symbol === 'BTCUSDT');
    const r2 = payload.find((p: any) => p.symbol === 'ETHUSDT');
    const r3 = payload.find((p: any) => p.symbol === 'SOLUSDT');
    expect(r1.gate_passed_until).toBeNull();         // LIQUIDITY_FLOOR = 1er gate
    expect(r2.gate_passed_until).toBe('volatility'); // PERSISTENCE = après volatility
    expect(r3.gate_passed_until).toBe('all');        // ACCEPT = passé tous gates
  });
});
