/**
 * Bug #A (13/05/2026) — Tests crypto simulator via Binance klines range.
 *
 * Couvre :
 *   - Flag CRYPTO_SIMULATOR_ENABLED off → short-circuit legacy crypto_not_supported
 *   - Flag on + binance manquant → error 'crypto_simulator_no_binance_service'
 *   - Flag on + symbol unmappable → error 'crypto_unmappable_symbol'
 *   - Flag on + binance retourne null → no_data 'binance_api_error'
 *   - Flag on + binance retourne [] → no_data 'empty_response'
 *   - Flag on + candles valides → walkForward run, TP/SL/TIME hits selon shape
 *   - Conversion ms→sec via normalizeAndSortCandles (timestamp Binance openTime
 *     en ms, converti automatiquement par auto-detect > 1e12)
 *   - getKlinesRange appelé avec startTime/endTime en MILLISECONDES
 *
 * Stratégie : mock BinanceMarketService directement (pas de réel HTTP).
 * Mock EodhdIntradayService minimal (jamais appelé sur crypto path).
 */
import {
  GainersUserShadowService,
  type FetchDiag,
} from '../services/gainers-user-shadow.service';
import type { BinanceCandle } from '../services/binance-market.service';

type BinanceCall = {
  method: 'getKlinesRange' | 'toBinanceSymbol';
  args: unknown[];
};

function buildService(opts: {
  klinesRangeResult: BinanceCandle[] | null;
  toBinanceSymbolResult?: string | null;
  withBinance?: boolean;
  callLog: BinanceCall[];
}): GainersUserShadowService {
  const eodhdMock = {
    getCandles: jest.fn(async () => null),
    getCandlesViaTicks: jest.fn(async () => null),
  };
  const supabaseMock = {
    getClient: () => ({
      from: () => ({
        select: () => ({
          is: () => ({
            lte: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
  };
  const binanceMock = {
    toBinanceSymbol: jest.fn((symbol: string) => {
      opts.callLog.push({ method: 'toBinanceSymbol', args: [symbol] });
      if (opts.toBinanceSymbolResult !== undefined) return opts.toBinanceSymbolResult;
      // Default passthrough behavior matching real BinanceMarketService
      const s = symbol.toUpperCase();
      if (s.endsWith('USDT')) return s;
      return null;
    }),
    getKlinesRange: jest.fn(
      async (sym: string, interval: string, startMs: number, endMs: number) => {
        opts.callLog.push({
          method: 'getKlinesRange',
          args: [sym, interval, startMs, endMs],
        });
        return opts.klinesRangeResult;
      },
    ),
  };
  return new GainersUserShadowService(
    supabaseMock as never,
    eodhdMock as never,
    undefined,
    opts.withBinance === false ? undefined : (binanceMock as never),
  );
}

// In-session timestamp pour crypto = n'importe quand (crypto 24/7). On choisit
// un Mercredi UTC pour cohérence avec autres tests.
function cryptoStartTs(): number {
  return Math.floor(new Date('2026-05-13T12:00:00Z').getTime() / 1000);
}

// Helper : construit N candles 5m alignées avec startTs, OHLC paramétrable.
function buildBinanceCandles(
  startTs: number,
  count: number,
  shape: (i: number) => { open: number; high: number; low: number; close: number },
): BinanceCandle[] {
  const candles: BinanceCandle[] = [];
  for (let i = 0; i < count; i++) {
    const openTimeMs = (startTs + i * 300) * 1000;  // 5min intervals in ms
    const { open, high, low, close } = shape(i);
    candles.push({
      openTime: openTimeMs,
      open,
      high,
      low,
      close,
      volume: 1000,
      closeTime: openTimeMs + 299_000,
      trades: 42,
    });
  }
  return candles;
}

async function runSim(
  svc: GainersUserShadowService,
  args: {
    symbol: string;
    assetClass: string;
    entryPrice: number;
    createdAt: string;
  },
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (svc as any).simulateRow(args);
}

describe('Bug #A — Crypto simulator via Binance', () => {
  const ORIGINAL_FLAG = process.env.CRYPTO_SIMULATOR_ENABLED;

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.CRYPTO_SIMULATOR_ENABLED;
    } else {
      process.env.CRYPTO_SIMULATOR_ENABLED = ORIGINAL_FLAG;
    }
  });

  describe('flag off (legacy short-circuit preserved)', () => {
    it('returns crypto_not_supported when CRYPTO_SIMULATOR_ENABLED is undefined', async () => {
      delete process.env.CRYPTO_SIMULATOR_ENABLED;
      const callLog: BinanceCall[] = [];
      const svc = buildService({ klinesRangeResult: null, callLog });

      const { fetchDiag } = (await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date().toISOString(),
      })) as { fetchDiag: FetchDiag };

      expect(fetchDiag.outcome).toBe('error');
      expect(fetchDiag.steps[0].error).toBe('crypto_not_supported');
      // Aucun appel à Binance car flag off
      expect(callLog).toHaveLength(0);
    });

    it('returns crypto_not_supported when flag is "false"', async () => {
      process.env.CRYPTO_SIMULATOR_ENABLED = 'false';
      const callLog: BinanceCall[] = [];
      const svc = buildService({ klinesRangeResult: null, callLog });

      const { fetchDiag } = (await runSim(svc, {
        symbol: 'ETHUSDT',
        assetClass: 'crypto_alt',
        entryPrice: 3000,
        createdAt: new Date().toISOString(),
      })) as { fetchDiag: FetchDiag };

      expect(fetchDiag.outcome).toBe('error');
      expect(fetchDiag.steps[0].error).toBe('crypto_not_supported');
      expect(callLog).toHaveLength(0);
    });

    it('returns crypto_simulator_no_binance_service when flag on but binance not injected', async () => {
      process.env.CRYPTO_SIMULATOR_ENABLED = 'true';
      const callLog: BinanceCall[] = [];
      const svc = buildService({
        klinesRangeResult: null,
        withBinance: false,
        callLog,
      });

      const { fetchDiag } = (await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date().toISOString(),
      })) as { fetchDiag: FetchDiag };

      expect(fetchDiag.outcome).toBe('error');
      expect(fetchDiag.steps[0].error).toBe('crypto_simulator_no_binance_service');
      expect(callLog).toHaveLength(0);
    });
  });

  describe('flag on + binance injected', () => {
    beforeEach(() => {
      process.env.CRYPTO_SIMULATOR_ENABLED = 'true';
    });

    it('emits crypto_unmappable_symbol when toBinanceSymbol returns null', async () => {
      const callLog: BinanceCall[] = [];
      const svc = buildService({
        klinesRangeResult: null,
        toBinanceSymbolResult: null,
        callLog,
      });

      const { fetchDiag } = (await runSim(svc, {
        symbol: 'UNKNOWN-COIN',
        assetClass: 'crypto_alt',
        entryPrice: 100,
        createdAt: new Date().toISOString(),
      })) as { fetchDiag: FetchDiag };

      expect(fetchDiag.outcome).toBe('error');
      expect(fetchDiag.steps[0].error).toBe('crypto_unmappable_symbol');
      // toBinanceSymbol appelé, mais getKlinesRange jamais
      expect(callLog.filter((c) => c.method === 'getKlinesRange')).toHaveLength(0);
      expect(callLog.filter((c) => c.method === 'toBinanceSymbol')).toHaveLength(1);
    });

    it('emits binance_api_error when getKlinesRange returns null', async () => {
      const callLog: BinanceCall[] = [];
      const svc = buildService({ klinesRangeResult: null, callLog });

      const { fetchDiag } = (await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date().toISOString(),
      })) as { fetchDiag: FetchDiag };

      expect(fetchDiag.outcome).toBe('no_data');
      expect(fetchDiag.steps).toHaveLength(1);
      expect(fetchDiag.steps[0].endpoint).toBe('binance_klines_range_5m');
      expect(fetchDiag.steps[0].error).toBe('binance_api_error');
      expect(fetchDiag.steps[0].rawCount).toBe(0);
    });

    it('emits empty_response when getKlinesRange returns []', async () => {
      const callLog: BinanceCall[] = [];
      const svc = buildService({ klinesRangeResult: [], callLog });

      const { fetchDiag } = (await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date().toISOString(),
      })) as { fetchDiag: FetchDiag };

      expect(fetchDiag.outcome).toBe('no_data');
      expect(fetchDiag.steps[0].error).toBe('empty_response');
      expect(fetchDiag.steps[0].validClose).toBe(0);
    });

    it('calls getKlinesRange with startTime/endTime in MILLISECONDS', async () => {
      const callLog: BinanceCall[] = [];
      const startTs = cryptoStartTs();
      const svc = buildService({ klinesRangeResult: [], callLog });

      await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date(startTs * 1000).toISOString(),
      });

      const rangeCall = callLog.find((c) => c.method === 'getKlinesRange');
      expect(rangeCall).toBeDefined();
      const [sym, interval, startMs, endMs] = rangeCall!.args as [
        string,
        string,
        number,
        number,
      ];
      expect(sym).toBe('BTCUSDT');
      expect(interval).toBe('5m');
      // Bug #A spec : fromTs = startTs - 300s, toTs = startTs + 3900s, multiplié par 1000 pour ms
      expect(startMs).toBe((startTs - 300) * 1000);
      expect(endMs).toBe((startTs + 60 * 60 + 300) * 1000);
    });

    it('runs walkForward and detects TP_HIT on a clean +5% candle', async () => {
      const callLog: BinanceCall[] = [];
      const startTs = cryptoStartTs();
      // 13 candles, candle 5 = TP hit (high > entry × 1.020 = 61_200 for baseline grid)
      const candles = buildBinanceCandles(startTs, 13, (i) => {
        if (i === 5) {
          return { open: 60_500, high: 62_000, low: 60_400, close: 61_500 };
        }
        return { open: 60_000, high: 60_200, low: 59_900, close: 60_100 };
      });
      const svc = buildService({ klinesRangeResult: candles, callLog });

      const { results, fetchDiag } = (await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date(startTs * 1000).toISOString(),
      })) as { results: Record<string, { outcome: string }>; fetchDiag: FetchDiag };

      expect(fetchDiag.outcome).toBe('ok');
      expect(fetchDiag.steps[0].endpoint).toBe('binance_klines_range_5m');
      expect(fetchDiag.steps[0].rawCount).toBe(13);
      expect(fetchDiag.steps[0].validClose).toBe(13);
      expect(fetchDiag.forwardCount).toBeGreaterThan(0);
      // baseline_30m : TP 2% → entry × 1.02 = 61_200 ; candle 5 high=62_000 → hit
      expect(results.baseline_30m.outcome).toBe('TP_HIT');
      expect(results.baseline_60m.outcome).toBe('TP_HIT');
    });

    it('runs walkForward and detects SL_HIT on a -2% drop', async () => {
      const callLog: BinanceCall[] = [];
      const startTs = cryptoStartTs();
      // candle 3 = SL hit (low < entry × 0.991 = 59_460 for baseline 0.9% sl)
      const candles = buildBinanceCandles(startTs, 13, (i) => {
        if (i === 3) {
          return { open: 60_000, high: 60_100, low: 58_500, close: 59_000 };
        }
        return { open: 60_000, high: 60_200, low: 59_800, close: 60_050 };
      });
      const svc = buildService({ klinesRangeResult: candles, callLog });

      const { results } = (await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date(startTs * 1000).toISOString(),
      })) as { results: Record<string, { outcome: string; pnl_pct: number | null }> };

      expect(results.baseline_30m.outcome).toBe('SL_HIT');
      // pnl_pct = -slPct - SLIPPAGE_TOTAL = -0.009 - 0.003 = -0.012
      expect(results.baseline_30m.pnl_pct).toBeCloseTo(-0.012, 5);
    });

    it('runs walkForward and returns TIME_LIMIT on a sideways path', async () => {
      const callLog: BinanceCall[] = [];
      const startTs = cryptoStartTs();
      // 13 candles toutes sideways +/-0.1% (ni TP 2% ni SL 0.9% hit)
      const candles = buildBinanceCandles(startTs, 13, () => ({
        open: 60_000,
        high: 60_050,
        low: 59_950,
        close: 60_010,
      }));
      const svc = buildService({ klinesRangeResult: candles, callLog });

      const { results } = (await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date(startTs * 1000).toISOString(),
      })) as {
        results: Record<string, { outcome: string; exit_price: number | null }>;
      };

      expect(results.baseline_30m.outcome).toBe('TIME_LIMIT');
      expect(results.baseline_30m.exit_price).toBeCloseTo(60_010, 1);
    });

    it('converts Binance openTime (ms) to seconds via normalizeAndSortCandles', async () => {
      const callLog: BinanceCall[] = [];
      const startTs = cryptoStartTs();
      const candles = buildBinanceCandles(startTs, 6, () => ({
        open: 60_000,
        high: 60_100,
        low: 59_900,
        close: 60_050,
      }));
      // Tous les openTime devraient être > 1e12 (ms)
      for (const c of candles) {
        expect(c.openTime).toBeGreaterThan(1e12);
      }
      const svc = buildService({ klinesRangeResult: candles, callLog });

      const { fetchDiag } = (await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date(startTs * 1000).toISOString(),
      })) as { fetchDiag: FetchDiag };

      // forwardCount > 0 prouve que normalizeAndSortCandles a converti
      // openTime ms → timestamp sec et que le filter timestamp >= startTs a pu matcher
      expect(fetchDiag.forwardCount).toBeGreaterThan(0);
      expect(fetchDiag.outcome).toBe('ok');
    });

    it('persists fetchDiag.startTs and cutoffTs60 for SQL post-mortem', async () => {
      const callLog: BinanceCall[] = [];
      const startTs = cryptoStartTs();
      const candles = buildBinanceCandles(startTs, 13, () => ({
        open: 60_000,
        high: 60_050,
        low: 59_950,
        close: 60_010,
      }));
      const svc = buildService({ klinesRangeResult: candles, callLog });

      const { fetchDiag } = (await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date(startTs * 1000).toISOString(),
      })) as { fetchDiag: FetchDiag };

      expect(fetchDiag.startTs).toBe(startTs);
      expect(fetchDiag.cutoffTs60).toBe(startTs + 60 * 60);
      expect(fetchDiag.selectedStep).toBe(0);
      expect(fetchDiag.applied_tz_offset_sec).toBe(0);
    });

    it('flags partial_window=true when Binance returns fewer candles than expected', async () => {
      // Bug #A P2 — Si Binance retourne 4 candles au lieu de 13 (gap réseau,
      // maintenance, etc.), simulator NE marque PAS no_data — il run walkForward
      // sur ce qu'il a + flag partial_window=true sur les outcomes hit/time.
      // Comportement aligné sur le path EODHD (lignes 933-955).
      //
      // Threshold default 0.5 : partial_window=true si forward < 12 × 0.5 = 6 candles.
      // 4 candles < 6 → partial_window=true sur TIME_LIMIT (pas de TP/SL hit ici).
      const callLog: BinanceCall[] = [];
      const startTs = cryptoStartTs();
      const candles = buildBinanceCandles(startTs, 4, () => ({
        open: 60_000,
        high: 60_050,
        low: 59_950,
        close: 60_010,
      }));
      const svc = buildService({ klinesRangeResult: candles, callLog });

      const { results, fetchDiag } = (await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date(startTs * 1000).toISOString(),
      })) as {
        results: Record<string, { outcome: string; partial_window?: boolean }>;
        fetchDiag: FetchDiag;
      };

      expect(fetchDiag.outcome).toBe('ok');
      expect(fetchDiag.forwardCount).toBe(4);
      // walkForward toujours run sur ces 4 candles → TIME_LIMIT pour grilles 30/60min
      expect(results.baseline_30m.outcome).toBe('TIME_LIMIT');
      expect(results.baseline_30m.partial_window).toBe(true);
      expect(results.baseline_60m.partial_window).toBe(true);
    });

    it('does NOT flag partial_window when forward >= threshold (12 × 0.5 = 6 candles)', async () => {
      // Bug #A P2 — Edge case symétrique : exactement 6 candles forward.
      // Threshold 0.5 default : `forward.length < 12 * 0.5` ⇒ `6 < 6` ⇒ false ⇒ pas partial.
      const callLog: BinanceCall[] = [];
      const startTs = cryptoStartTs();
      const candles = buildBinanceCandles(startTs, 6, () => ({
        open: 60_000,
        high: 60_050,
        low: 59_950,
        close: 60_010,
      }));
      const svc = buildService({ klinesRangeResult: candles, callLog });

      const { results } = (await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date(startTs * 1000).toISOString(),
      })) as {
        results: Record<string, { outcome: string; partial_window?: boolean }>;
      };

      expect(results.baseline_30m.outcome).toBe('TIME_LIMIT');
      // partial_window absent (=== undefined) quand forward >= threshold
      expect(results.baseline_30m.partial_window).toBeUndefined();
    });

    it('returns priceSnapshots at 5/15/30/60 minutes on successful walkForward', async () => {
      const callLog: BinanceCall[] = [];
      const startTs = cryptoStartTs();
      const candles = buildBinanceCandles(startTs, 13, (i) => ({
        open: 60_000 + i * 10,
        high: 60_050 + i * 10,
        low: 59_950 + i * 10,
        close: 60_010 + i * 10,
      }));
      const svc = buildService({ klinesRangeResult: candles, callLog });

      const { priceSnapshots } = (await runSim(svc, {
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        entryPrice: 60_000,
        createdAt: new Date(startTs * 1000).toISOString(),
      })) as {
        priceSnapshots: { '5': number | null; '15': number | null; '30': number | null; '60': number | null };
      };

      expect(priceSnapshots).toBeDefined();
      // 5 min = candle 1 (i=1), close = 60_020
      expect(priceSnapshots['5']).toBeCloseTo(60_020, 0);
      // 15 min = candle 3 (i=3), close = 60_040
      expect(priceSnapshots['15']).toBeCloseTo(60_040, 0);
    });
  });
});
