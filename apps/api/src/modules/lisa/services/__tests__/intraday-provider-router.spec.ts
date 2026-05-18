/**
 * PR #352/PR #353 — Tests IntradayProviderRouter dual-call.
 *
 * Couverture :
 *   - Flag OFF → EODHD only (TD jamais appelé)
 *   - Flag ON + symbol mappable + ratio positif → dual-call EODHD + TD
 *   - TD null/empty → EODHD prend la main, mais EODHD reste appelé
 *   - TD success → préféré, MAIS EODHD reste appelé en parallèle
 *   - Symbol unmappable (suffixe inconnu) → EODHD only
 *   - options.fromTs/toTs → EODHD only (TD ne supporte pas time-range)
 *   - convertToTdSymbol couvre US, EU, asia (KO/KQ/SHG/SHE/HK/T/AU)
 *   - Hash A/B déterministe par symbol
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
  lastCandlesOptions: unknown;
} {
  const counters = {
    quoteCalls: 0,
    candlesCalls: 0,
    lastCandlesOptions: undefined as unknown,
  };
  const service = {
    getQuote: (_t: string) => {
      counters.quoteCalls += 1;
      return Promise.resolve(opts?.quote ?? null);
    },
    getCandles: (_t: string, _i: '1m' | '5m' | '1h', _c: number, options?: unknown) => {
      counters.candlesCalls += 1;
      counters.lastCandlesOptions = options;
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
    get lastCandlesOptions() {
      return counters.lastCandlesOptions;
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
  lastSymbol: string | null;
} {
  const counters = {
    quoteCalls: 0,
    candlesCalls: 0,
    lastSymbol: null as string | null,
  };
  const service = {
    getQuote: (s: string, _by?: string) => {
      counters.quoteCalls += 1;
      counters.lastSymbol = s;
      return Promise.resolve(opts?.quote ?? null);
    },
    getCandles: (s: string, _i: string, _o?: number, _by?: string) => {
      counters.candlesCalls += 1;
      counters.lastSymbol = s;
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
    get lastSymbol() {
      return counters.lastSymbol;
    },
  };
}

const TD_OK_QUOTE = { price: 180.5, changePct: 1.2, timestamp: 1747353600000 };
const EODHD_OK_QUOTE = { price: 180.4, changePct: 1.1, timestamp: 1747353500000 };
const TD_OK_CANDLES = {
  symbol: 'AAPL',
  interval: '1min',
  candles: [{ timestamp: 1747353600, open: 1, high: 1, low: 1, close: 180.5, volume: 100 }],
  asOf: 1747353600000,
};
const EODHD_OK_CANDLES = {
  ticker: 'AAPL.US',
  interval: '1m' as const,
  candles: [{ timestamp: 1747353500, open: 1, high: 1, low: 1, close: 180.4, volume: 100 }],
  asOf: 1747353500000,
};

describe('IntradayProviderRouter — PR #352/353 dual-call', () => {
  describe('flag OFF → EODHD only', () => {
    it('getQuote n\'appelle jamais TD', async () => {
      const eodhd = makeEodhdMock({ quote: EODHD_OK_QUOTE });
      const td = makeTdMock({ quote: TD_OK_QUOTE });
      const router = new IntradayProviderRouter(
        makeConfig({ TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'false' }),
        eodhd.service,
        td.service,
      );
      const r = await router.getQuote('AAPL.US');
      expect(r!.provider).toBe('eodhd');
      expect(eodhd.quoteCalls).toBe(1);
      expect(td.quoteCalls).toBe(0);
    });

    it('getCandles n\'appelle jamais TD', async () => {
      const eodhd = makeEodhdMock({ candles: EODHD_OK_CANDLES });
      const td = makeTdMock({ candles: TD_OK_CANDLES });
      const router = new IntradayProviderRouter(
        makeConfig({ TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'false' }),
        eodhd.service,
        td.service,
      );
      const r = await router.getCandles('AAPL.US', '1m', 20);
      expect(r!.provider).toBe('eodhd');
      expect(eodhd.candlesCalls).toBe(1);
      expect(td.candlesCalls).toBe(0);
    });
  });

  describe('flag ON + ratio 1.0 → dual-call EODHD + TD', () => {
    it('getQuote appelle EODHD ET TD, préfère TD si succès', async () => {
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
      // EODHD ET TD appelés en parallèle (contrainte user ZERO offload)
      expect(eodhd.quoteCalls).toBe(1);
      expect(td.quoteCalls).toBe(1);
    });

    it('getCandles 1m appelle TD avec symbol mappé', async () => {
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
      expect(td.lastSymbol).toBe('AAPL');
      expect(eodhd.candlesCalls).toBe(1);
      expect(td.candlesCalls).toBe(1);
    });
  });

  describe('TD null/empty → fallback EODHD (EODHD reste appelé)', () => {
    it('TD null → return EODHD, EODHD compté 1×', async () => {
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

    it('TD candles=[] → fallback EODHD', async () => {
      const eodhd = makeEodhdMock({ candles: EODHD_OK_CANDLES });
      const td = makeTdMock({
        candles: { symbol: 'AAPL', interval: '1min', candles: [], asOf: 0 },
      });
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

  describe('options.fromTs/toTs → EODHD only (pas de TD)', () => {
    it('fromTs présent → TD pas appelé, EODHD appelé avec options propagées', async () => {
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
      await router.getCandles('AAPL.US', '5m', 20, { fromTs: 1000, toTs: 2000 });
      expect(td.candlesCalls).toBe(0);
      expect(eodhd.candlesCalls).toBe(1);
      expect(eodhd.lastCandlesOptions).toEqual({ fromTs: 1000, toTs: 2000 });
    });
  });

  describe('Symbol unmappable → EODHD only', () => {
    it('suffixe .XYZ inconnu → EODHD only', async () => {
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
      await router.getCandles('SOMETHING.XYZ', '1m', 20);
      expect(td.candlesCalls).toBe(0);
      expect(eodhd.candlesCalls).toBe(1);
    });
  });

  describe('convertToTdSymbol — US + EU + asia (PR #353)', () => {
    const router = new IntradayProviderRouter(
      makeConfig({ TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true' }),
      makeEodhdMock().service,
      makeTdMock().service,
    );

    it.each([
      ['AAPL', 'AAPL'], // sans suffixe
      ['AAPL.US', 'AAPL'],
      ['BARC.LSE', 'BARC:LSE'],
      ['BARC.L', 'BARC:LSE'],
      ['BNP.PA', 'BNP:Euronext'],
      ['ASML.AS', 'ASML:Euronext'],
      ['BMW.XETRA', 'BMW:XETR'],
      ['BMW.DE', 'BMW:XETR'],
      ['NESN.SW', 'NESN:SIX'],
      ['STM.MI', 'STM:MIL'],
      ['SHOP.TO', 'SHOP:TSX'],
      // PR #353 — asia (76% du trafic intraday)
      ['005930.KO', '005930:KRX'], // Samsung KOSPI
      ['086790.KQ', '086790:KRX'], // KOSDAQ
      ['600519.SHG', '600519:SSE'], // Shanghai
      ['300024.SHE', '300024:SZSE'], // Shenzhen
      ['0700.HK', '0700:HKEX'], // Tencent HK
      ['7203.T', '7203:XTKS'], // Toyota Tokyo
      ['CBA.AU', 'CBA:XASX'], // ASX
    ])('%s → %s', (input, expected) => {
      expect(router.convertToTdSymbol(input)).toBe(expected);
    });

    it.each([
      'SOMETHING.XYZ',
      'FOO.BAR',
      'TEST.ZZZ',
    ])('%s → null (suffixe inconnu)', (input) => {
      expect(router.convertToTdSymbol(input)).toBeNull();
    });
  });

  describe('A/B ratio déterministe par symbol', () => {
    it('ratio 0.5 → ~50/50 split sur 100 symbols', async () => {
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
      // EODHD toujours appelé 100×, TD appelé ~50× (entre 30 et 70)
      expect(eodhd.quoteCalls).toBe(100);
      expect(td.quoteCalls).toBeGreaterThanOrEqual(30);
      expect(td.quoteCalls).toBeLessThanOrEqual(70);
    });

    it('shouldRouteToTd déterministe pour un même symbol', () => {
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

    it('ratio 0.0 → TD jamais appelé', async () => {
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
      expect(td.quoteCalls).toBe(0);
      expect(eodhd.quoteCalls).toBe(1);
    });

    it('ratio invalide ("2.0") → fallback 1.0 (100% TD)', async () => {
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

  describe('Sans TwelveDataService injecté → EODHD only', () => {
    it('flag ON mais td=null → EODHD only', async () => {
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

  describe('Asia routing — scénario PR #353 (76% du trafic)', () => {
    it('005930.KO routé vers TD avec symbol mappé 005930:KRX', async () => {
      const eodhd = makeEodhdMock({
        candles: { ...EODHD_OK_CANDLES, ticker: '005930.KO' },
      });
      const td = makeTdMock({
        candles: { ...TD_OK_CANDLES, symbol: '005930:KRX' },
      });
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        eodhd.service,
        td.service,
      );
      const r = await router.getCandles('005930.KO', '5m', 100, { calledBy: 'shadow_walkforward' });
      expect(r!.provider).toBe('td');
      expect(td.lastSymbol).toBe('005930:KRX');
      expect(eodhd.candlesCalls).toBe(1);
      expect(td.candlesCalls).toBe(1);
    });

    it('600519.SHG routé vers TD avec symbol 600519:SSE', async () => {
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
      await router.getCandles('600519.SHG', '1m', 20);
      expect(td.lastSymbol).toBe('600519:SSE');
    });
  });
});
