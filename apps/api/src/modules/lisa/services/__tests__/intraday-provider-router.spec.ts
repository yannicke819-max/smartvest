/**
 * PR #352 — Tests IntradayProviderRouter.
 *
 * Couverture :
 *   - Flag OFF → 100% EODHD (passthrough)
 *   - Flag ON + ratio 1.0 → 100% TD (mock TD success)
 *   - Flag ON + ratio 0.0 → 100% EODHD
 *   - Flag ON + ratio 0.5 → ~50/50 (statistique sur 100 symbols)
 *   - TD null → fallback EODHD obligatoire
 *   - TD success → EODHD jamais appelé
 *   - Symbol asia (.KO) → routed EODHD direct (unmappable)
 *   - Symbol US → routed TD si flag ON
 *   - Hash déterministe : shouldRouteToTd retourne toujours pareil
 *   - Sans TwelveDataService injecté → 100% EODHD
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntradayProviderRouter } from '../intraday-provider-router.service';
import { TwelveDataService } from '../twelve-data.service';
import { EodhdIntradayService } from '../eodhd-intraday.service';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

function makeConfig(env: Record<string, string>): ConfigService {
  return { get: jest.fn((k: string) => env[k]) } as unknown as ConfigService;
}

function makeEodhdMock(opts?: {
  quote?: { price: number; changePct: number; timestamp: number } | null;
  candles?: { ticker: string; interval: '1m' | '5m' | '1h'; candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>; asOf: number; rawCount?: number } | null;
}): {
  service: EodhdIntradayService;
  quoteCalls: number;
  candlesCalls: number;
} {
  const counters = { quoteCalls: 0, candlesCalls: 0 };
  const service = {
    getQuote: (_t: string) => {
      counters.quoteCalls += 1;
      return Promise.resolve(opts?.quote ?? null);
    },
    getCandles: (_t: string, _i: '1m' | '5m' | '1h', _c: number) => {
      counters.candlesCalls += 1;
      return Promise.resolve(opts?.candles ?? null);
    },
  } as unknown as EodhdIntradayService;
  return {
    service,
    get quoteCalls() {
      return counters.quoteCalls;
    },
    get candlesCalls() {
      return counters.candlesCalls;
    },
  };
}

function makeTdMock(opts?: {
  quote?: { price: number; changePct: number; timestamp: number } | null;
  candles?: { symbol: string; interval: string; candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>; asOf: number } | null;
}): {
  service: TwelveDataService;
  quoteCalls: number;
  candlesCalls: number;
} {
  const counters = { quoteCalls: 0, candlesCalls: 0 };
  const service = {
    getQuote: (_s: string, _by?: string) => {
      counters.quoteCalls += 1;
      return Promise.resolve(opts?.quote ?? null);
    },
    getCandles: (_s: string, _i: string, _o?: number, _by?: string) => {
      counters.candlesCalls += 1;
      return Promise.resolve(opts?.candles ?? null);
    },
  } as unknown as TwelveDataService;
  return {
    service,
    get quoteCalls() {
      return counters.quoteCalls;
    },
    get candlesCalls() {
      return counters.candlesCalls;
    },
  };
}

const TD_OK_QUOTE = { price: 180.5, changePct: 1.2, timestamp: 1747353600000 };
const EODHD_OK_QUOTE = { price: 180.4, changePct: 1.1, timestamp: 1747353500000 };
const TD_OK_CANDLES = {
  symbol: 'AAPL',
  interval: '1min',
  candles: [
    { timestamp: 1747353600, open: 1, high: 1, low: 1, close: 180.5, volume: 100 },
  ],
  asOf: 1747353600000,
};
const EODHD_OK_CANDLES = {
  ticker: 'AAPL.US',
  interval: '1m' as const,
  candles: [
    { timestamp: 1747353500, open: 1, high: 1, low: 1, close: 180.4, volume: 100 },
  ],
  asOf: 1747353500000,
};

describe('IntradayProviderRouter — PR #352', () => {
  describe('flag OFF → 100% EODHD', () => {
    it('getQuote utilise EODHD, jamais TD', async () => {
      const eodhd = makeEodhdMock({ quote: EODHD_OK_QUOTE });
      const td = makeTdMock({ quote: TD_OK_QUOTE });
      const router = new IntradayProviderRouter(
        makeConfig({ TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'false' }),
        eodhd.service,
        td.service,
      );
      const r = await router.getQuote('AAPL.US');
      expect(r).not.toBeNull();
      expect(r!.provider).toBe('eodhd');
      expect(r!.price).toBe(EODHD_OK_QUOTE.price);
      expect(eodhd.quoteCalls).toBe(1);
      expect(td.quoteCalls).toBe(0);
    });

    it('getCandles utilise EODHD, jamais TD', async () => {
      const eodhd = makeEodhdMock({ candles: EODHD_OK_CANDLES });
      const td = makeTdMock({ candles: TD_OK_CANDLES });
      const router = new IntradayProviderRouter(
        makeConfig({ TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'false' }),
        eodhd.service,
        td.service,
      );
      const r = await router.getCandles('AAPL.US', '1m', 20);
      expect(r).not.toBeNull();
      expect(r!.provider).toBe('eodhd');
      expect(eodhd.candlesCalls).toBe(1);
      expect(td.candlesCalls).toBe(0);
    });
  });

  describe('flag ON + ratio 1.0 → 100% TD', () => {
    it('getQuote utilise TD, EODHD jamais appelé', async () => {
      const eodhd = makeEodhdMock({ quote: EODHD_OK_QUOTE });
      const td = makeTdMock({ quote: TD_OK_QUOTE });
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        eodhd.service,
        td.service,
      );
      const r = await router.getQuote('AAPL.US');
      expect(r!.provider).toBe('td');
      expect(r!.price).toBe(TD_OK_QUOTE.price);
      expect(td.quoteCalls).toBe(1);
      expect(eodhd.quoteCalls).toBe(0);
    });

    it('getCandles 1m utilise TD avec interval mappé 1min', async () => {
      const eodhd = makeEodhdMock({ candles: EODHD_OK_CANDLES });
      const td = makeTdMock({ candles: TD_OK_CANDLES });
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        eodhd.service,
        td.service,
      );
      const r = await router.getCandles('AAPL.US', '1m', 20);
      expect(r!.provider).toBe('td');
      expect(r!.candles).toHaveLength(1);
      expect(r!.candles[0].close).toBe(180.5);
      expect(td.candlesCalls).toBe(1);
      expect(eodhd.candlesCalls).toBe(0);
    });
  });

  describe('flag ON + ratio 0.0 → 100% EODHD', () => {
    it('getQuote utilise EODHD, TD jamais appelé', async () => {
      const eodhd = makeEodhdMock({ quote: EODHD_OK_QUOTE });
      const td = makeTdMock({ quote: TD_OK_QUOTE });
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '0.0',
        }),
        eodhd.service,
        td.service,
      );
      await router.getQuote('AAPL.US');
      expect(eodhd.quoteCalls).toBe(1);
      expect(td.quoteCalls).toBe(0);
    });
  });

  describe('flag ON + ratio 0.5 → ~50/50 split déterministe', () => {
    it('100 symbols différents → entre 30 et 70 routés TD', async () => {
      const eodhd = makeEodhdMock({ quote: EODHD_OK_QUOTE });
      const td = makeTdMock({ quote: TD_OK_QUOTE });
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '0.5',
        }),
        eodhd.service,
        td.service,
      );
      for (let i = 0; i < 100; i++) {
        await router.getQuote(`SYM${i}.US`);
      }
      // Distribution attendue ~50/50, on accepte large [30..70]
      expect(td.quoteCalls).toBeGreaterThanOrEqual(30);
      expect(td.quoteCalls).toBeLessThanOrEqual(70);
      expect(eodhd.quoteCalls).toBe(100 - td.quoteCalls);
    });
  });

  describe('TD null → fallback EODHD', () => {
    it('getQuote : TD null → EODHD appelé, provider=eodhd', async () => {
      const eodhd = makeEodhdMock({ quote: EODHD_OK_QUOTE });
      const td = makeTdMock({ quote: null });
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        eodhd.service,
        td.service,
      );
      const r = await router.getQuote('AAPL.US');
      expect(r!.provider).toBe('eodhd');
      expect(td.quoteCalls).toBe(1);
      expect(eodhd.quoteCalls).toBe(1);
    });

    it('getCandles : TD null → EODHD fallback', async () => {
      const eodhd = makeEodhdMock({ candles: EODHD_OK_CANDLES });
      const td = makeTdMock({ candles: null });
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        eodhd.service,
        td.service,
      );
      const r = await router.getCandles('AAPL.US', '1m', 20);
      expect(r!.provider).toBe('eodhd');
      expect(td.candlesCalls).toBe(1);
      expect(eodhd.candlesCalls).toBe(1);
    });

    it('getCandles : TD candles=[] → EODHD fallback', async () => {
      const eodhd = makeEodhdMock({ candles: EODHD_OK_CANDLES });
      const td = makeTdMock({ candles: { symbol: 'AAPL', interval: '1min', candles: [], asOf: 0 } });
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        eodhd.service,
        td.service,
      );
      const r = await router.getCandles('AAPL.US', '1m', 20);
      expect(r!.provider).toBe('eodhd');
      expect(td.candlesCalls).toBe(1);
      expect(eodhd.candlesCalls).toBe(1);
    });
  });

  describe('TD success → EODHD jamais appelé', () => {
    it('getQuote TD OK', async () => {
      const eodhd = makeEodhdMock({ quote: EODHD_OK_QUOTE });
      const td = makeTdMock({ quote: TD_OK_QUOTE });
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        eodhd.service,
        td.service,
      );
      await router.getQuote('AAPL.US');
      expect(eodhd.quoteCalls).toBe(0);
    });
  });

  describe('Symbol unmappable (asia/HK) → EODHD direct', () => {
    it('.KO → EODHD direct, TD jamais appelé', async () => {
      const eodhd = makeEodhdMock({ quote: EODHD_OK_QUOTE });
      const td = makeTdMock({ quote: TD_OK_QUOTE });
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        eodhd.service,
        td.service,
      );
      const r = await router.getQuote('005930.KO');
      expect(r!.provider).toBe('eodhd');
      expect(td.quoteCalls).toBe(0);
      expect(eodhd.quoteCalls).toBe(1);
    });

    it('.HK / .T / .AU / .SHG / .SHE → unmappable', () => {
      const router = new IntradayProviderRouter(
        makeConfig({ TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true' }),
        makeEodhdMock().service,
        makeTdMock().service,
      );
      expect(router.convertToTdSymbol('0700.HK')).toBeNull();
      expect(router.convertToTdSymbol('7203.T')).toBeNull();
      expect(router.convertToTdSymbol('CBA.AU')).toBeNull();
      expect(router.convertToTdSymbol('600519.SHG')).toBeNull();
      expect(router.convertToTdSymbol('300024.SHE')).toBeNull();
    });

    it('mapping suffixes connus', () => {
      const router = new IntradayProviderRouter(
        makeConfig({ TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true' }),
        makeEodhdMock().service,
        makeTdMock().service,
      );
      expect(router.convertToTdSymbol('AAPL.US')).toBe('AAPL');
      expect(router.convertToTdSymbol('AAPL')).toBe('AAPL'); // sans suffixe
      expect(router.convertToTdSymbol('BARC.LSE')).toBe('BARC:LSE');
      expect(router.convertToTdSymbol('BARC.L')).toBe('BARC:LSE');
      expect(router.convertToTdSymbol('BNP.PA')).toBe('BNP:Euronext');
      expect(router.convertToTdSymbol('BMW.XETRA')).toBe('BMW:XETR');
      expect(router.convertToTdSymbol('BMW.DE')).toBe('BMW:XETR');
      expect(router.convertToTdSymbol('NESN.SW')).toBe('NESN:SIX');
    });
  });

  describe('Hash déterministe', () => {
    it('shouldRouteToTd(symbol) retourne toujours pareil pour le même symbol', () => {
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '0.5',
        }),
        makeEodhdMock().service,
        makeTdMock().service,
      );
      const first = router.shouldRouteToTd('AAPL');
      for (let i = 0; i < 50; i++) {
        expect(router.shouldRouteToTd('AAPL')).toBe(first);
      }
    });
  });

  describe('Sans TwelveDataService injecté → 100% EODHD', () => {
    it('getQuote utilise EODHD même si flag ON', async () => {
      const eodhd = makeEodhdMock({ quote: EODHD_OK_QUOTE });
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        eodhd.service,
        null,
      );
      const r = await router.getQuote('AAPL.US');
      expect(r!.provider).toBe('eodhd');
      expect(eodhd.quoteCalls).toBe(1);
    });
  });

  describe('Ratio invalide → fallback à 1.0', () => {
    it('ratio="-1" ou "2.0" → 100% TD (default 1.0)', async () => {
      const eodhd = makeEodhdMock({ quote: EODHD_OK_QUOTE });
      const td = makeTdMock({ quote: TD_OK_QUOTE });
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '2.0',
        }),
        eodhd.service,
        td.service,
      );
      await router.getQuote('AAPL.US');
      expect(td.quoteCalls).toBe(1);
    });
  });
});
