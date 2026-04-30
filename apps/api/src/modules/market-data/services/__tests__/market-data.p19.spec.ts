/**
 * P19 — FK violation `quotes_asset_id_fkey` regression tests.
 *
 * Bug observed in prod (29/04/2026 10:15:01 UTC, issue #84) :
 *   `MarketDataScheduler.refreshQuotes` failing with FK violation 23503
 *   because `getOpenPositionAssets` used `lisa_positions.id` as `assetId`,
 *   which is not a valid FK to `assets.id`.
 *
 * Fix: `ensureAssetRow` upserts a real `assets` row before any quote insert,
 * eliminating the FK violation at source.
 */

import { Logger } from '@nestjs/common';
import { MarketDataService, normalizeAssetClass } from '../market-data.service';

// ── Stubs ──────────────────────────────────────────────────────────────────

const supabaseFromMock = jest.fn();
const mockSupabase = {
  isReady: () => true,
  getClient: () => ({ from: supabaseFromMock }),
} as any;
const mockRegistry = {} as any;

const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

beforeEach(() => {
  logSpy.mockClear();
  warnSpy.mockClear();
  errorSpy.mockClear();
  supabaseFromMock.mockReset();
});

// ── normalizeAssetClass ─────────────────────────────────────────────────────

describe('normalizeAssetClass', () => {
  it('maps crypto_major / crypto_alt / crypto_tradable → crypto', () => {
    expect(normalizeAssetClass('crypto_major')).toBe('crypto');
    expect(normalizeAssetClass('crypto_alt')).toBe('crypto');
    expect(normalizeAssetClass('crypto_tradable')).toBe('crypto');
    expect(normalizeAssetClass('crypto')).toBe('crypto');
  });

  it('maps us_equity_large / eu_equity / asia_equity → equity', () => {
    expect(normalizeAssetClass('us_equity_large')).toBe('equity');
    expect(normalizeAssetClass('us_equity_small_mid')).toBe('equity');
    expect(normalizeAssetClass('eu_equity')).toBe('equity');
    expect(normalizeAssetClass('asia_equity')).toBe('equity');
  });

  it('maps fx_major / fx_cross → derivative', () => {
    expect(normalizeAssetClass('fx_major')).toBe('derivative');
    expect(normalizeAssetClass('fx_cross')).toBe('derivative');
    expect(normalizeAssetClass('forex')).toBe('derivative');
  });

  it('maps commodity → commodity', () => {
    expect(normalizeAssetClass('commodity')).toBe('commodity');
  });

  it('falls back to "other" for null / undefined / unknown', () => {
    expect(normalizeAssetClass(null)).toBe('other');
    expect(normalizeAssetClass(undefined)).toBe('other');
    expect(normalizeAssetClass('')).toBe('other');
    expect(normalizeAssetClass('something_weird')).toBe('other');
  });

  it('all returned values are within the assets.asset_class CHECK constraint set', () => {
    const allowed = new Set(['equity', 'etf', 'bond', 'fund', 'cash', 'crypto', 'commodity', 'derivative', 'other']);
    const samples = ['crypto_major', 'us_equity_large', 'fx_major', 'commodity', 'cash', 'unknown', null, undefined, ''];
    for (const s of samples) {
      expect(allowed.has(normalizeAssetClass(s))).toBe(true);
    }
  });
});

// ── ensureAssetRow ──────────────────────────────────────────────────────────

describe('MarketDataService.ensureAssetRow', () => {
  function setupExistingAsset(id: string, providerTickers: Record<string, string> = {}) {
    const maybeSingle = jest.fn().mockResolvedValue({ data: { id, provider_tickers: providerTickers }, error: null });
    const limit = jest.fn().mockReturnValue({ maybeSingle });
    const eq = jest.fn().mockReturnValue({ limit });
    const select = jest.fn().mockReturnValue({ eq });
    const updateEq = jest.fn().mockResolvedValue({ data: null, error: null });
    const update = jest.fn().mockReturnValue({ eq: updateEq });
    supabaseFromMock.mockImplementation((table: string) => {
      if (table === 'assets') return { select, update };
      return { select: jest.fn() };
    });
    return { update, updateEq };
  }

  function setupNoExistingAsset(insertResult: { data: { id: string } | null; error: any }) {
    const maybeSingleSel = jest.fn().mockResolvedValue({ data: null, error: null });
    const limit = jest.fn().mockReturnValue({ maybeSingle: maybeSingleSel });
    const eq = jest.fn().mockReturnValue({ limit });
    const selectExisting = jest.fn().mockReturnValue({ eq });

    const single = jest.fn().mockResolvedValue(insertResult);
    const selectAfterInsert = jest.fn().mockReturnValue({ single });
    const insert = jest.fn().mockReturnValue({ select: selectAfterInsert });

    let callCount = 0;
    supabaseFromMock.mockImplementation((table: string) => {
      if (table === 'assets') {
        callCount++;
        if (callCount === 1) return { select: selectExisting };
        return { insert };
      }
      return { select: jest.fn() };
    });
    return { insert };
  }

  it('returns existing asset id when ticker already present, no insert', async () => {
    const { update } = setupExistingAsset('aaaa-1111-2222-3333', { eodhd: 'AAPL.US' });
    const svc = new MarketDataService(mockSupabase, mockRegistry);
    const id = await (svc as any).ensureAssetRow('AAPL', 'AAPL.US', 'USD', 'equity');
    expect(id).toBe('aaaa-1111-2222-3333');
    expect(update).not.toHaveBeenCalled();
  });

  it('patches provider_tickers.eodhd when missing on existing asset', async () => {
    const { update } = setupExistingAsset('aaaa-1111-2222-3333', { /* no eodhd key */ });
    const svc = new MarketDataService(mockSupabase, mockRegistry);
    const id = await (svc as any).ensureAssetRow('NVDA', 'NVDA.US', 'USD', 'equity');
    expect(id).toBe('aaaa-1111-2222-3333');
    expect(update).toHaveBeenCalledTimes(1);
    const updateArg = update.mock.calls[0][0];
    expect(updateArg.provider_tickers).toEqual({ eodhd: 'NVDA.US' });
    expect(updateArg.updated_at).toBeDefined();
  });

  it('inserts a new asset row when ticker is absent and returns its id', async () => {
    const { insert } = setupNoExistingAsset({ data: { id: 'bbbb-9999' }, error: null });
    const svc = new MarketDataService(mockSupabase, mockRegistry);
    const id = await (svc as any).ensureAssetRow('BTC', 'BTC-USD.CC', 'USD', 'crypto');
    expect(id).toBe('bbbb-9999');
    expect(insert).toHaveBeenCalledTimes(1);
    const insertArg = insert.mock.calls[0][0];
    expect(insertArg).toEqual({
      ticker: 'BTC',
      name: 'BTC',
      asset_class: 'crypto',
      currency: 'USD',
      provider_tickers: { eodhd: 'BTC-USD.CC' },
    });
  });

  it('returns null when insert fails (caller skips this ticker)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { insert } = setupNoExistingAsset({ data: null, error: { message: 'unique constraint violation' } });
    const svc = new MarketDataService(mockSupabase, mockRegistry);
    const id = await (svc as any).ensureAssetRow('BAD', 'BAD.US', 'USD', 'other');
    expect(id).toBeNull();
    expect(insert).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns null when supabase is not ready (defensive)', async () => {
    const notReady = { isReady: () => false, getClient: () => ({}) } as any;
    const svc = new MarketDataService(notReady, mockRegistry);
    const id = await (svc as any).ensureAssetRow('X', 'X.US', 'USD', 'equity');
    expect(id).toBeNull();
  });
});

// ── saveQuotes — FK violation diagnostic logging ────────────────────────────

describe('MarketDataService.saveQuotes — FK violation diagnostic', () => {
  it('logs offending asset_ids when Postgres returns code 23503 (FK violation)', async () => {
    const upsert = jest.fn().mockResolvedValue({
      error: { code: '23503', message: 'insert or update on table "quotes" violates foreign key constraint "quotes_asset_id_fkey"' },
    });
    supabaseFromMock.mockImplementation((table: string) => {
      if (table === 'quotes') return { upsert };
      return { upsert: jest.fn() };
    });

    const svc = new MarketDataService(mockSupabase, mockRegistry);
    const quotes = [
      { assetId: 'orphan-1', price: '100', currency: 'USD', asOf: '2026-04-29T10:00:00Z', provider: 'eodhd', marketState: 'open' as const, ticker: 'X' },
      { assetId: 'orphan-2', price: '50', currency: 'USD', asOf: '2026-04-29T10:00:00Z', provider: 'eodhd', marketState: 'open' as const, ticker: 'Y' },
      { assetId: 'orphan-1', price: '101', currency: 'USD', asOf: '2026-04-29T10:00:30Z', provider: 'eodhd', marketState: 'open' as const, ticker: 'X' }, // duplicate id
    ];
    const result = await (svc as any).saveQuotes(quotes, 3);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(3);

    const fkLogCall = errorSpy.mock.calls.find((c) =>
      String(c[0]).includes('P19 FK violation quotes_asset_id_fkey'),
    );
    expect(fkLogCall).toBeDefined();
    const msg = String(fkLogCall![0]);
    expect(msg).toContain('2 unique asset_id(s)');
    expect(msg).toContain('orphan-1');
    expect(msg).toContain('orphan-2');
  });

  it('does NOT emit FK diagnostic for non-23503 errors', async () => {
    errorSpy.mockClear();
    const upsert = jest.fn().mockResolvedValue({
      error: { code: '40001', message: 'serialization_failure' },
    });
    supabaseFromMock.mockImplementation((table: string) => {
      if (table === 'quotes') return { upsert };
      return { upsert: jest.fn() };
    });

    const svc = new MarketDataService(mockSupabase, mockRegistry);
    const quotes = [{ assetId: 'a', price: '1', currency: 'USD', asOf: '2026-04-29T10:00:00Z', provider: 'eodhd', marketState: 'open' as const, ticker: 'A' }];
    await (svc as any).saveQuotes(quotes, 1);

    const fkLogCall = errorSpy.mock.calls.find((c) =>
      String(c[0]).includes('P19 FK violation'),
    );
    expect(fkLogCall).toBeUndefined();
  });
});
