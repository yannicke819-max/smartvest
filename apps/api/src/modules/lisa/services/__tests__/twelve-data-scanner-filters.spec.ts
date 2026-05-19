/**
 * PR #345 — tests pour evaluateTwelveDataFilters (helper pur).
 *
 * Couvre :
 *   - Supertrend US : flag OFF → no call, flag ON + down → reject, ON + up → accept
 *   - RSI crypto    : flag OFF → no call, flag ON + RSI 82 → reject, ON + RSI 50 → accept
 *   - TwelveData null (rate limit / clé absente) → fail-open accept
 *   - asset_class non éligible → bypass
 *   - symbole crypto non mappable → bypass
 *   - flags croisés (US flag ON sur crypto signal → bypass)
 */

import { evaluateTwelveDataFilters } from '../twelve-data-scanner-filters';
import { TwelveDataService } from '../twelve-data.service';

interface MockCounters {
  supertrendCalls: number;
  rsiCalls: number;
  lastRsiArgs: unknown[] | null;
  lastSupertrendArgs: unknown[] | null;
}

function makeTwelveDataMock(overrides: {
  supertrend?: Awaited<ReturnType<TwelveDataService['getSupertrendSignal']>>;
  rsi?: Awaited<ReturnType<TwelveDataService['getRsi']>>;
}): { service: TwelveDataService; counters: MockCounters } {
  const counters: MockCounters = { supertrendCalls: 0, rsiCalls: 0, lastRsiArgs: null, lastSupertrendArgs: null };
  const service = {
    getSupertrendSignal: (...args: unknown[]) => {
      counters.supertrendCalls += 1;
      counters.lastSupertrendArgs = args;
      return Promise.resolve(overrides.supertrend ?? null);
    },
    getRsi: (...args: unknown[]) => {
      counters.rsiCalls += 1;
      counters.lastRsiArgs = args;
      return Promise.resolve(overrides.rsi ?? null);
    },
    constructor: TwelveDataService,
  } as unknown as TwelveDataService;
  return { service, counters };
}

describe('evaluateTwelveDataFilters — PR #345', () => {
  describe('Filtre Supertrend US (flag OFF)', () => {
    it('flag OFF → no call TwelveData même si signal US', async () => {
      const { service: td, counters } = makeTwelveDataMock({
        supertrend: { value: 180, direction: 'down', timestamp: '2026-05-17 14:00' },
      });
      const r = await evaluateTwelveDataFilters({
        symbol: 'AAPL',
        assetClass: 'us_equity_large',
        supertrendEnabled: false,
        cryptoRsiEnabled: false,
        twelveData: td,
      });
      expect(r.decision).toBe('accept');
      expect(counters.supertrendCalls).toBe(0);
    });
  });

  describe('Filtre Supertrend US (flag ON)', () => {
    it('us_equity_large + direction=down → reject_supertrend_down', async () => {
      const { service: td, counters } = makeTwelveDataMock({
        supertrend: { value: 180.5, direction: 'down', timestamp: '2026-05-17 14:00' },
      });
      const r = await evaluateTwelveDataFilters({
        symbol: 'AAPL',
        assetClass: 'us_equity_large',
        supertrendEnabled: true,
        cryptoRsiEnabled: false,
        twelveData: td,
      });
      expect(r.decision).toBe('reject_supertrend_down');
      if (r.decision === 'reject_supertrend_down') {
        expect(r.reason).toContain('direction=down');
        expect(r.reason).toContain('180.5');
      }
      expect(counters.supertrendCalls).toBe(1);
    });

    it('us_equity_small_mid + direction=down → reject (les 2 classes US couvertes)', async () => {
      const { service: td, counters } = makeTwelveDataMock({
        supertrend: { value: 50, direction: 'down', timestamp: 'now' },
      });
      const r = await evaluateTwelveDataFilters({
        symbol: 'SMALLCO',
        assetClass: 'us_equity_small_mid',
        supertrendEnabled: true,
        cryptoRsiEnabled: false,
        twelveData: td,
      });
      expect(r.decision).toBe('reject_supertrend_down');
    });

    it('direction=up → accept', async () => {
      const { service: td, counters } = makeTwelveDataMock({
        supertrend: { value: 180, direction: 'up', timestamp: 'now' },
      });
      const r = await evaluateTwelveDataFilters({
        symbol: 'AAPL',
        assetClass: 'us_equity_large',
        supertrendEnabled: true,
        cryptoRsiEnabled: false,
        twelveData: td,
      });
      expect(r.decision).toBe('accept');
    });

    it('TwelveData retourne null (rate limit / clé absente) → fail-open accept', async () => {
      const { service: td, counters } = makeTwelveDataMock({ supertrend: null });
      const r = await evaluateTwelveDataFilters({
        symbol: 'AAPL',
        assetClass: 'us_equity_large',
        supertrendEnabled: true,
        cryptoRsiEnabled: false,
        twelveData: td,
      });
      expect(r.decision).toBe('accept');
      expect(counters.supertrendCalls).toBe(1); // appel tenté
    });

    it('asset_class eu_equity → bypass (filtre US seulement)', async () => {
      const { service: td, counters } = makeTwelveDataMock({
        supertrend: { value: 50, direction: 'down', timestamp: 'now' },
      });
      const r = await evaluateTwelveDataFilters({
        symbol: 'NESN.SW',
        assetClass: 'eu_equity',
        supertrendEnabled: true,
        cryptoRsiEnabled: false,
        twelveData: td,
      });
      expect(r.decision).toBe('accept');
      expect(counters.supertrendCalls).toBe(0); // pas d'appel pour EU
    });

    it('asset_class crypto_major + supertrend flag ON → bypass (filtre US only)', async () => {
      const { service: td, counters } = makeTwelveDataMock({
        supertrend: { value: 50, direction: 'down', timestamp: 'now' },
      });
      const r = await evaluateTwelveDataFilters({
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        supertrendEnabled: true,
        cryptoRsiEnabled: false,
        twelveData: td,
      });
      expect(r.decision).toBe('accept');
      expect(counters.supertrendCalls).toBe(0);
    });
  });

  describe('Filtre RSI crypto (flag ON)', () => {
    it('RSI > 75 → reject_rsi_overbought + symbol mappé BTCUSDT → BTC/USD', async () => {
      const { service: td, counters } = makeTwelveDataMock({ rsi: { value: 82.34, timestamp: 'now' } });
      const r = await evaluateTwelveDataFilters({
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        supertrendEnabled: false,
        cryptoRsiEnabled: true,
        twelveData: td,
      });
      expect(r.decision).toBe('reject_rsi_overbought');
      if (r.decision === 'reject_rsi_overbought') {
        expect(r.reason).toContain('RSI 82.34');
        expect(r.reason).toContain('> 75');
      }
      expect(counters.rsiCalls).toBe(1);
      expect(counters.lastRsiArgs?.[0]).toBe('BTC/USD');
    });

    it('RSI = 50 (neutre) → accept', async () => {
      const { service: td, counters } = makeTwelveDataMock({ rsi: { value: 50, timestamp: 'now' } });
      const r = await evaluateTwelveDataFilters({
        symbol: 'ETHUSDT',
        assetClass: 'crypto_major',
        supertrendEnabled: false,
        cryptoRsiEnabled: true,
        twelveData: td,
      });
      expect(r.decision).toBe('accept');
    });

    it('RSI = 75 exact → accept (seuil strict >)', async () => {
      const { service: td, counters } = makeTwelveDataMock({ rsi: { value: 75, timestamp: 'now' } });
      const r = await evaluateTwelveDataFilters({
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        supertrendEnabled: false,
        cryptoRsiEnabled: true,
        twelveData: td,
      });
      expect(r.decision).toBe('accept');
    });

    it('symbole non mappable Binance → bypass, accept', async () => {
      const { service: td, counters } = makeTwelveDataMock({ rsi: { value: 90, timestamp: 'now' } });
      const r = await evaluateTwelveDataFilters({
        symbol: 'INVALID_NOT_A_PAIR',
        assetClass: 'crypto_major',
        supertrendEnabled: false,
        cryptoRsiEnabled: true,
        twelveData: td,
      });
      expect(r.decision).toBe('accept');
      expect(counters.rsiCalls).toBe(0);
    });

    it('TwelveData null (rate limit) → fail-open accept', async () => {
      const { service: td, counters } = makeTwelveDataMock({ rsi: null });
      const r = await evaluateTwelveDataFilters({
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        supertrendEnabled: false,
        cryptoRsiEnabled: true,
        twelveData: td,
      });
      expect(r.decision).toBe('accept');
    });

    it('asset_class us_equity_large + RSI flag ON → bypass (filtre crypto only)', async () => {
      const { service: td, counters } = makeTwelveDataMock({ rsi: { value: 90, timestamp: 'now' } });
      const r = await evaluateTwelveDataFilters({
        symbol: 'AAPL',
        assetClass: 'us_equity_large',
        supertrendEnabled: false,
        cryptoRsiEnabled: true,
        twelveData: td,
      });
      expect(r.decision).toBe('accept');
      expect(counters.rsiCalls).toBe(0);
    });
  });

  describe('Filtres simultanés (les deux ON)', () => {
    it('us_equity_large + supertrend down → reject (RSI non appelé même si flag ON)', async () => {
      const { service: td, counters } = makeTwelveDataMock({
        supertrend: { value: 100, direction: 'down', timestamp: 'now' },
      });
      const r = await evaluateTwelveDataFilters({
        symbol: 'AAPL',
        assetClass: 'us_equity_large',
        supertrendEnabled: true,
        cryptoRsiEnabled: true,
        twelveData: td,
      });
      expect(r.decision).toBe('reject_supertrend_down');
      expect(counters.rsiCalls).toBe(0); // pas appelé sur asset_class US
    });

    it('crypto_major + RSI 80 → reject (Supertrend non appelé même si flag ON)', async () => {
      const { service: td, counters } = makeTwelveDataMock({ rsi: { value: 80, timestamp: 'now' } });
      const r = await evaluateTwelveDataFilters({
        symbol: 'BTCUSDT',
        assetClass: 'crypto_major',
        supertrendEnabled: true,
        cryptoRsiEnabled: true,
        twelveData: td,
      });
      expect(r.decision).toBe('reject_rsi_overbought');
      expect(counters.supertrendCalls).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // PR #355 — strip suffixe EODHD avant l'appel TD Supertrend (fix bug
  // 100% reject parce que AAPL.US n'est pas reconnu par TwelveData).
  // ───────────────────────────────────────────────────────────────────────
  describe('PR #355 — strip suffixe EODHD avant getSupertrendSignal', () => {
    it('AAPL.US → strip → "AAPL" passé à TD', async () => {
      const { service: td, counters } = makeTwelveDataMock({
        supertrend: { value: 180, direction: 'up', timestamp: 'now' },
      });
      await evaluateTwelveDataFilters({
        symbol: 'AAPL.US',
        assetClass: 'us_equity_large',
        supertrendEnabled: true,
        cryptoRsiEnabled: false,
        twelveData: td,
      });
      expect(counters.supertrendCalls).toBe(1);
      expect(counters.lastSupertrendArgs?.[0]).toBe('AAPL'); // pas 'AAPL.US'
    });

    it('EACO.US, EOG.US (tickers observés prod en erreur) → strippés', async () => {
      const samples = ['EACO.US', 'EOG.US', 'KOS.US', 'FDS.US', 'BLDP.US'];
      for (const symbol of samples) {
        const { service: td, counters } = makeTwelveDataMock({
          supertrend: { value: 100, direction: 'up', timestamp: 'now' },
        });
        await evaluateTwelveDataFilters({
          symbol,
          assetClass: 'us_equity_large',
          supertrendEnabled: true,
          cryptoRsiEnabled: false,
          twelveData: td,
        });
        expect(counters.lastSupertrendArgs?.[0]).toBe(symbol.replace('.US', ''));
      }
    });

    it('AAPL (sans suffixe) → passé tel quel', async () => {
      const { service: td, counters } = makeTwelveDataMock({
        supertrend: { value: 180, direction: 'up', timestamp: 'now' },
      });
      await evaluateTwelveDataFilters({
        symbol: 'AAPL',
        assetClass: 'us_equity_large',
        supertrendEnabled: true,
        cryptoRsiEnabled: false,
        twelveData: td,
      });
      expect(counters.lastSupertrendArgs?.[0]).toBe('AAPL');
    });

    it('FOO.XYZ (suffixe inconnu) → mapper retourne null → pas d\'appel TD', async () => {
      const { service: td, counters } = makeTwelveDataMock({
        supertrend: { value: 100, direction: 'down', timestamp: 'now' },
      });
      const r = await evaluateTwelveDataFilters({
        symbol: 'FOO.XYZ',
        assetClass: 'us_equity_large',
        supertrendEnabled: true,
        cryptoRsiEnabled: false,
        twelveData: td,
      });
      expect(counters.supertrendCalls).toBe(0); // fail-open : pas d'appel
      expect(r.decision).toBe('accept');
    });
  });
});
