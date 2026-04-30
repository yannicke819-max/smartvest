/**
 * P19i — Tests pour IntradayCacheService (cache Supabase OHLCV intraday).
 *
 * Garanties :
 *   - write() upsert proprement, failure-tolerant (Supabase down → false)
 *   - read() retourne null si > 15 min (TTL applicatif)
 *   - read() retourne CachedSeries avec ageMs computed à la lecture
 *   - read()/write() ne throwent jamais (silent debug log)
 *   - service is_ready=false → no-op
 */

import { Logger } from '@nestjs/common';
import { IntradayCacheService } from '../intraday-cache.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

const upsertMock = jest.fn();
const maybeSingleMock = jest.fn();

function makeSupabase(ready = true) {
  return {
    isReady: () => ready,
    getClient: () => ({
      from: () => ({
        upsert: upsertMock,
        select: () => ({
          eq: () => ({
            maybeSingle: maybeSingleMock,
          }),
        }),
      }),
    }),
  } as any;
}

beforeEach(() => {
  upsertMock.mockReset();
  maybeSingleMock.mockReset();
});

describe('IntradayCacheService — P19i', () => {
  describe('write()', () => {
    it('upserts symbol/source/candles + fetched_at', async () => {
      upsertMock.mockResolvedValue({ error: null });
      const svc = new IntradayCacheService(makeSupabase());
      const ok = await svc.write('AAPL', 'yahoo', [
        { timestamp: 1761830400, open: 180, high: 181, low: 179, close: 180.5, volume: 1000 },
      ]);
      expect(ok).toBe(true);
      expect(upsertMock).toHaveBeenCalledTimes(1);
      const [row, opts] = upsertMock.mock.calls[0];
      expect(row.symbol).toBe('AAPL');
      expect(row.source).toBe('yahoo');
      expect(row.candles).toHaveLength(1);
      expect(row.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(opts).toEqual({ onConflict: 'symbol' });
    });

    it('returns false silently when Supabase returns an error', async () => {
      upsertMock.mockResolvedValue({ error: { message: 'rls violation' } });
      const svc = new IntradayCacheService(makeSupabase());
      const ok = await svc.write('AAPL', 'yahoo', [
        { timestamp: 1761830400, open: 180, high: 181, low: 179, close: 180.5, volume: 1000 },
      ]);
      expect(ok).toBe(false);
    });

    it('returns false when supabase is not ready', async () => {
      const svc = new IntradayCacheService(makeSupabase(false));
      const ok = await svc.write('AAPL', 'yahoo', [{ timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
      expect(ok).toBe(false);
      expect(upsertMock).not.toHaveBeenCalled();
    });

    it('returns false on empty candles array (no-op)', async () => {
      const svc = new IntradayCacheService(makeSupabase());
      const ok = await svc.write('AAPL', 'yahoo', []);
      expect(ok).toBe(false);
      expect(upsertMock).not.toHaveBeenCalled();
    });

    it('uppercase normalization on symbol', async () => {
      upsertMock.mockResolvedValue({ error: null });
      const svc = new IntradayCacheService(makeSupabase());
      await svc.write('aapl', 'yahoo', [{ timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
      expect(upsertMock.mock.calls[0][0].symbol).toBe('AAPL');
    });

    it('does NOT throw on supabase exception', async () => {
      upsertMock.mockRejectedValue(new Error('connection refused'));
      const svc = new IntradayCacheService(makeSupabase());
      const ok = await svc.write('AAPL', 'yahoo', [{ timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
      expect(ok).toBe(false);
    });
  });

  describe('read()', () => {
    it('returns CachedSeries with ageMs when fetched_at < 15 min ago', async () => {
      const fetchedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
      maybeSingleMock.mockResolvedValue({
        data: {
          symbol: 'AAPL',
          source: 'yahoo',
          candles: [{ timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
          fetched_at: fetchedAt,
        },
        error: null,
      });
      const svc = new IntradayCacheService(makeSupabase());
      const r = await svc.read('AAPL');
      expect(r).not.toBeNull();
      expect(r!.symbol).toBe('AAPL');
      expect(r!.source).toBe('yahoo');
      expect(r!.candles).toHaveLength(1);
      expect(r!.ageMs).toBeGreaterThan(0);
      expect(r!.ageMs).toBeLessThan(15 * 60 * 1000);
    });

    it('returns null when fetched_at > 15 min ago (TTL expired)', async () => {
      const fetchedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString(); // 16 min ago
      maybeSingleMock.mockResolvedValue({
        data: {
          symbol: 'AAPL',
          source: 'yahoo',
          candles: [{ timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
          fetched_at: fetchedAt,
        },
        error: null,
      });
      const svc = new IntradayCacheService(makeSupabase());
      const r = await svc.read('AAPL');
      expect(r).toBeNull();
    });

    it('returns null when no row exists', async () => {
      maybeSingleMock.mockResolvedValue({ data: null, error: null });
      const svc = new IntradayCacheService(makeSupabase());
      const r = await svc.read('UNKNOWN');
      expect(r).toBeNull();
    });

    it('returns null when supabase is not ready', async () => {
      const svc = new IntradayCacheService(makeSupabase(false));
      const r = await svc.read('AAPL');
      expect(r).toBeNull();
      expect(maybeSingleMock).not.toHaveBeenCalled();
    });

    it('returns null and does NOT throw on supabase error', async () => {
      maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'connection refused' } });
      const svc = new IntradayCacheService(makeSupabase());
      const r = await svc.read('AAPL');
      expect(r).toBeNull();
    });

    it('returns null when candles array is empty (defensive)', async () => {
      const fetchedAt = new Date(Date.now() - 1000).toISOString();
      maybeSingleMock.mockResolvedValue({
        data: { symbol: 'AAPL', source: 'yahoo', candles: [], fetched_at: fetchedAt },
        error: null,
      });
      const svc = new IntradayCacheService(makeSupabase());
      const r = await svc.read('AAPL');
      expect(r).toBeNull();
    });
  });
});
