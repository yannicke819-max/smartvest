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
import { TickerBlacklistService } from '../ticker-blacklist.service';
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

// PR #357 — mock minimal TickerBlacklistService. Par défaut, aucun ticker
// blacklisté (comportement neutre identique à l'ancien @Optional null).
// Tests qui veulent simuler une blacklist active passent { blacklisted: ['XYZ.US'] }.
function makeBlacklistMock(opts?: { blacklisted?: string[] }): TickerBlacklistService {
  const set = new Set(opts?.blacklisted ?? []);
  return {
    isBlacklisted: (ticker: string) => set.has(ticker),
    recordStrike: () => undefined,
    getStats: () => ({ staticEnabled: true, staticSize: 0, dynamicCount: 0, strikesThreshold: 3, ttlHours: 24 }),
  } as unknown as TickerBlacklistService;
}

// PR #366 — SupabaseService mock (no-op insert) pour le compare-table.
function makeSupabaseMock(): import('../../../supabase/supabase.service').SupabaseService {
  return {
    isReady: () => false, // false = pas d'insert tenté dans les tests par défaut
    getClient: () => ({ from: () => ({ insert: () => Promise.resolve({ error: null }) }) }),
  } as unknown as import('../../../supabase/supabase.service').SupabaseService;
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
        makeBlacklistMock(), makeSupabaseMock(),
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
        makeBlacklistMock(), makeSupabaseMock(),
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
        makeBlacklistMock(), makeSupabaseMock(),
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
        makeBlacklistMock(), makeSupabaseMock(),
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
        makeBlacklistMock(), makeSupabaseMock(),
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
        makeBlacklistMock(), makeSupabaseMock(),
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
        makeBlacklistMock(), makeSupabaseMock(),
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
        makeBlacklistMock(), makeSupabaseMock(),
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
      makeBlacklistMock(), makeSupabaseMock(),
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
      ['SHOP.TO', 'SHOP:TSX'],
      // PR #353 — asia supportée par plan TD Pro
      ['005930.KO', '005930:KRX'], // Samsung KOSPI
      ['086790.KQ', '086790:KRX'], // KOSDAQ
      ['600519.SHG', '600519:SSE'], // Shanghai
      ['300024.SHE', '300024:SZSE'], // Shenzhen
      // PR #355 — .MI/.T/.HK/.AU retournent null (add-ons TD non actifs),
      // testé séparément ci-dessous.
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

    // PR #355 — add-ons TD payants non actifs (validé live 19/05/2026)
    it.each([
      'STM.MI', // Milan
      '7203.T', // Tokyo JPX
      '0700.HK', // HKEX
      'CBA.AU', // ASX XASX
    ])('%s → null (add-on TD non actif)', (input) => {
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
        makeBlacklistMock(), makeSupabaseMock(),
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
        makeBlacklistMock(), makeSupabaseMock(),
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
        makeBlacklistMock(), makeSupabaseMock(),
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
        makeBlacklistMock(), makeSupabaseMock(),
      );
      await router.getQuote('AAPL.US');
      expect(td.quoteCalls).toBe(1);
    });
  });

  describe('Sans TwelveDataService injecté → EODHD only', () => {
    it('flag ON mais td=null → EODHD only', async () => {
      const eodhd = makeEodhdMock({ quote: EODHD_OK_QUOTE });
      // PR #356 : td est désormais required par DI. On simule la pathologie
      // historique (DI cassé qui injectait null silencieusement) via cast,
      // pour vérifier que le guard défensif isEnabled()→false tient toujours.
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        eodhd.service,
        null as unknown as TwelveDataService,
        makeBlacklistMock(), makeSupabaseMock(),
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
        makeBlacklistMock(), makeSupabaseMock(),
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
        makeBlacklistMock(), makeSupabaseMock(),
      );
      await router.getCandles('600519.SHG', '1m', 20);
      expect(td.lastSymbol).toBe('600519:SSE');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // PR #354 — td_skip_reason observability
  //
  // Diag prod 18/05 12h Paris : 100% des events `intraday_router_dual_call`
  // avaient `td_symbol: null` et `td_attempted: false` → assumé à tort comme
  // bug de mapping. Vrai cause = panier ~11 symbols récurrents .US/.TO qui
  // hashent tous vers >= 20 avec ratio 0.2 (FNV-1a déterministe). Ces tests
  // confirment (a) que .US/.TO sont bien mappés et (b) que td_skip_reason
  // distingue désormais les 3 causes de skip.
  // ───────────────────────────────────────────────────────────────────────
  describe('PR #354 — convertToTdSymbol .US et .TO (anti-régression mapping)', () => {
    const router = new IntradayProviderRouter(
      makeConfig({}),
      makeEodhdMock().service,
      makeTdMock().service,
      makeBlacklistMock(), makeSupabaseMock(),
    );

    it('AAPL.US → AAPL (strip suffixe)', () => {
      expect(router.convertToTdSymbol('AAPL.US')).toBe('AAPL');
    });

    it('DCBO.TO → DCBO:TSX', () => {
      expect(router.convertToTdSymbol('DCBO.TO')).toBe('DCBO:TSX');
    });

    it('EACO.US, EOG.US, KOS.US, FDS.US, BLDP.US (tickers observés prod) → mappés', () => {
      expect(router.convertToTdSymbol('EACO.US')).toBe('EACO');
      expect(router.convertToTdSymbol('EOG.US')).toBe('EOG');
      expect(router.convertToTdSymbol('KOS.US')).toBe('KOS');
      expect(router.convertToTdSymbol('FDS.US')).toBe('FDS');
      expect(router.convertToTdSymbol('BLDP.US')).toBe('BLDP');
    });

    it('KEI.TO, LCFS.TO, SDE.TO, TNZ.TO, MATR.TO (tickers observés prod) → mappés :TSX', () => {
      expect(router.convertToTdSymbol('KEI.TO')).toBe('KEI:TSX');
      expect(router.convertToTdSymbol('LCFS.TO')).toBe('LCFS:TSX');
      expect(router.convertToTdSymbol('SDE.TO')).toBe('SDE:TSX');
      expect(router.convertToTdSymbol('TNZ.TO')).toBe('TNZ:TSX');
      expect(router.convertToTdSymbol('MATR.TO')).toBe('MATR:TSX');
    });
  });

  describe('PR #354 — td_skip_reason dans logs intraday_router_dual_call', () => {
    function captureLogs(): { calls: string[]; restore: () => void } {
      const calls: string[] = [];
      const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((msg: unknown) => {
        if (typeof msg === 'string') calls.push(msg);
        return undefined as never;
      });
      return { calls, restore: () => spy.mockRestore() };
    }

    function lastDualCall(calls: string[]): Record<string, unknown> | null {
      for (let i = calls.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(calls[i]);
          if (parsed?.event === 'intraday_router_dual_call') return parsed;
        } catch {
          // not JSON, skip
        }
      }
      return null;
    }

    it('flag OFF → td_skip_reason="flag_off"', async () => {
      const { calls, restore } = captureLogs();
      const router = new IntradayProviderRouter(
        makeConfig({ TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'false' }),
        makeEodhdMock({ candles: EODHD_OK_CANDLES }).service,
        makeTdMock({ candles: TD_OK_CANDLES }).service,
        makeBlacklistMock(), makeSupabaseMock(),
      );
      await router.getCandles('AAPL.US', '1m', 20);
      const log = lastDualCall(calls);
      restore();
      expect(log).not.toBeNull();
      expect(log!.td_skip_reason).toBe('flag_off');
      expect(log!.td_attempted).toBe(false);
    });

    it('options.fromTs présent → td_skip_reason="time_window_present"', async () => {
      const { calls, restore } = captureLogs();
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        makeEodhdMock({ candles: EODHD_OK_CANDLES }).service,
        makeTdMock({ candles: TD_OK_CANDLES }).service,
        makeBlacklistMock(), makeSupabaseMock(),
      );
      await router.getCandles('AAPL.US', '5m', 20, { fromTs: 1000, toTs: 2000 });
      const log = lastDualCall(calls);
      restore();
      expect(log!.td_skip_reason).toBe('time_window_present');
    });

    it('ratio 0.0 → td_skip_reason="ab_test_sent_to_eodhd"', async () => {
      const { calls, restore } = captureLogs();
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '0.0',
        }),
        makeEodhdMock({ candles: EODHD_OK_CANDLES }).service,
        makeTdMock({ candles: TD_OK_CANDLES }).service,
        makeBlacklistMock(), makeSupabaseMock(),
      );
      await router.getCandles('AAPL.US', '1m', 20);
      const log = lastDualCall(calls);
      restore();
      expect(log!.td_skip_reason).toBe('ab_test_sent_to_eodhd');
    });

    it('suffixe .XYZ inconnu + ratio 1.0 → td_skip_reason="unsupported_suffix"', async () => {
      const { calls, restore } = captureLogs();
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        makeEodhdMock({ candles: EODHD_OK_CANDLES }).service,
        makeTdMock({ candles: TD_OK_CANDLES }).service,
        makeBlacklistMock(), makeSupabaseMock(),
      );
      await router.getCandles('SOMETHING.XYZ', '1m', 20);
      const log = lastDualCall(calls);
      restore();
      expect(log!.td_skip_reason).toBe('unsupported_suffix');
    });

    it('TD non injecté + flag ON → td_skip_reason="td_not_injected"', async () => {
      const { calls, restore } = captureLogs();
      // PR #356 : cast pour simuler pathologie DI (td required mais null en runtime).
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        makeEodhdMock({ candles: EODHD_OK_CANDLES }).service,
        null as unknown as TwelveDataService,
        makeBlacklistMock(), makeSupabaseMock(),
      );
      await router.getCandles('AAPL.US', '1m', 20);
      const log = lastDualCall(calls);
      restore();
      expect(log!.td_skip_reason).toBe('td_not_injected');
    });

    it('TD éligible et appelé → td_skip_reason=null', async () => {
      const { calls, restore } = captureLogs();
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        makeEodhdMock({ candles: EODHD_OK_CANDLES }).service,
        makeTdMock({ candles: TD_OK_CANDLES }).service,
        makeBlacklistMock(), makeSupabaseMock(),
      );
      await router.getCandles('AAPL.US', '1m', 20);
      const log = lastDualCall(calls);
      restore();
      expect(log!.td_skip_reason).toBeNull();
      expect(log!.td_attempted).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // PR #366 — recordProviderCompare (instrumentation TD vs EODHD)
  // ───────────────────────────────────────────────────────────────────────
  describe('PR #366 — recordProviderCompare divergence bps', () => {
    function captureInsert(): {
      supabase: import('../../../supabase/supabase.service').SupabaseService;
      rows: Array<Record<string, unknown>>;
    } {
      const rows: Array<Record<string, unknown>> = [];
      const supabase = {
        isReady: () => true,
        getClient: () => ({
          from: () => ({
            insert: (row: Record<string, unknown>) => {
              rows.push(row);
              return Promise.resolve({ error: null });
            },
          }),
        }),
      } as unknown as import('../../../supabase/supabase.service').SupabaseService;
      return { supabase, rows };
    }

    it('divergence positive : TD plus haut → bps > 0', async () => {
      const { supabase, rows } = captureInsert();
      const router = new IntradayProviderRouter(
        makeConfig({}),
        makeEodhdMock().service,
        makeTdMock().service,
        makeBlacklistMock(),
        supabase,
      );
      await router.recordProviderCompare(
        '005930.KO',
        '005930:KRX',
        '5m',
        { candles: [{ timestamp: 100, close: 101.0 }] }, // TD
        { candles: [{ timestamp: 100, close: 100.0 }] }, // EODHD
        'test',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].td_close).toBe(101.0);
      expect(rows[0].eodhd_close).toBe(100.0);
      // (101 - 100) / 100 * 10000 = 100 bps
      expect(rows[0].divergence_bps).toBe(100);
      expect(rows[0].symbol).toBe('005930.KO');
      expect(rows[0].td_symbol).toBe('005930:KRX');
    });

    it('divergence nulle : prix identiques → 0 bps', async () => {
      const { supabase, rows } = captureInsert();
      const router = new IntradayProviderRouter(
        makeConfig({}),
        makeEodhdMock().service,
        makeTdMock().service,
        makeBlacklistMock(),
        supabase,
      );
      await router.recordProviderCompare(
        'AAPL.US', 'AAPL', '1m',
        { candles: [{ timestamp: 1, close: 180.0 }] },
        { candles: [{ timestamp: 1, close: 180.0 }] },
        'test',
      );
      expect(rows[0].divergence_bps).toBe(0);
    });

    it('eodhd_close <= 0 → divergence_bps null (pas de division)', async () => {
      const { supabase, rows } = captureInsert();
      const router = new IntradayProviderRouter(
        makeConfig({}),
        makeEodhdMock().service,
        makeTdMock().service,
        makeBlacklistMock(),
        supabase,
      );
      await router.recordProviderCompare(
        'X.US', 'X', '1m',
        { candles: [{ timestamp: 1, close: 50 }] },
        { candles: [{ timestamp: 1, close: 0 }] },
        'test',
      );
      expect(rows[0].divergence_bps).toBeNull();
    });

    it('supabase non ready → pas d\'insert', async () => {
      const rows: Array<Record<string, unknown>> = [];
      const supabase = {
        isReady: () => false,
        getClient: () => ({ from: () => ({ insert: (r: Record<string, unknown>) => { rows.push(r); return Promise.resolve({ error: null }); } }) }),
      } as unknown as import('../../../supabase/supabase.service').SupabaseService;
      const router = new IntradayProviderRouter(
        makeConfig({}), makeEodhdMock().service, makeTdMock().service, makeBlacklistMock(), supabase,
      );
      await router.recordProviderCompare(
        'X.US', 'X', '1m',
        { candles: [{ timestamp: 1, close: 50 }] },
        { candles: [{ timestamp: 1, close: 49 }] },
        'test',
      );
      expect(rows).toHaveLength(0);
    });

    it('dual-call getCandles avec 2 succès → insert auto', async () => {
      const { supabase, rows } = captureInsert();
      const router = new IntradayProviderRouter(
        makeConfig({
          TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'true',
          TWELVEDATA_INTRADAY_AB_TEST_RATIO: '1.0',
        }),
        makeEodhdMock({ candles: EODHD_OK_CANDLES }).service,
        makeTdMock({ candles: TD_OK_CANDLES }).service,
        makeBlacklistMock(),
        supabase,
      );
      await router.getCandles('AAPL.US', '1m', 20);
      // EODHD_OK_CANDLES close=180.4, TD_OK_CANDLES close=180.5
      expect(rows).toHaveLength(1);
      expect(rows[0].td_close).toBe(180.5);
      expect(rows[0].eodhd_close).toBe(180.4);
    });

    // Fix 21/05 — alignement par timestamp commun.
    it('séries désalignées (aucun ts commun) → divergence_bps null, ligne conservée', async () => {
      const { supabase, rows } = captureInsert();
      const router = new IntradayProviderRouter(
        makeConfig({}),
        makeEodhdMock().service,
        makeTdMock().service,
        makeBlacklistMock(),
        supabase,
      );
      await router.recordProviderCompare(
        '024840.KQ', '024840:KRX', '5m',
        { candles: [{ timestamp: 1779375600, close: 6890 }] }, // TD frais
        { candles: [{ timestamp: 1779256800, close: 5300 }] }, // EODHD stale (33h avant)
        'test',
      );
      expect(rows).toHaveLength(1);
      // Pas de bougie de ts commun → on ne calcule pas une divergence bidon.
      expect(rows[0].divergence_bps).toBeNull();
      // ts bruts conservés pour mesurer le taux de désalignement.
      expect(rows[0].td_candle_ts).toBe(1779375600);
      expect(rows[0].eodhd_candle_ts).toBe(1779256800);
    });

    it('ts commun plus ancien que la dernière bougie → divergence calculée sur le commun', async () => {
      const { supabase, rows } = captureInsert();
      const router = new IntradayProviderRouter(
        makeConfig({}),
        makeEodhdMock().service,
        makeTdMock().service,
        makeBlacklistMock(),
        supabase,
      );
      await router.recordProviderCompare(
        'AAPL.US', 'AAPL', '1m',
        { candles: [{ timestamp: 100, close: 180.0 }, { timestamp: 160, close: 181.0 }] }, // TD a une bougie 160 de plus
        { candles: [{ timestamp: 100, close: 180.5 }] }, // EODHD s'arrête à 100
        'test',
      );
      expect(rows).toHaveLength(1);
      // Comparaison sur ts=100 (commun), pas sur la dernière bougie TD (160).
      expect(rows[0].td_candle_ts).toBe(100);
      expect(rows[0].eodhd_candle_ts).toBe(100);
      expect(rows[0].td_close).toBe(180.0);
      expect(rows[0].eodhd_close).toBe(180.5);
      // (180.0 - 180.5) / 180.5 * 10000 = -27.7 bps
      expect(rows[0].divergence_bps).toBeCloseTo(-27.7, 0);
    });
  });

  // getLiveQuote — source live pour les stops sur marchés non couverts par
  // EODHD live (Corée/Chine). Indépendant du flag scanner A/B.
  describe('getLiveQuote — TD-first live price pour stops asie', () => {
    function makeRouter(env: Record<string, string>, tdQuote: { price: number; changePct: number; timestamp: number } | null) {
      const eodhd = makeEodhdMock({});
      const td = makeTdMock({ quote: tdQuote });
      const router = new IntradayProviderRouter(
        makeConfig(env),
        eodhd.service,
        td.service,
        makeBlacklistMock(),
        makeSupabaseMock(),
      );
      return { router, td };
    }

    it('ticker coréen (.KO) → renvoie le prix TD avec source twelvedata', async () => {
      const { router, td } = makeRouter({}, { price: 70000, changePct: 2.1, timestamp: 1747353600000 });
      const r = await router.getLiveQuote('005930.KO');
      expect(r).toEqual({ price: 70000, source: 'twelvedata' });
      expect(td.lastSymbol).toBe('005930:KRX');
    });

    it('fonctionne même si le flag scanner A/B est OFF (stops indépendants)', async () => {
      const { router } = makeRouter({ TWELVEDATA_INTRADAY_SCANNER_ENABLED: 'false' }, { price: 1500, changePct: 1, timestamp: 1 });
      const r = await router.getLiveQuote('600519.SHG');
      expect(r).toEqual({ price: 1500, source: 'twelvedata' });
    });

    it('suffixe hors périmètre (US) → null sans appeler TD', async () => {
      const { router, td } = makeRouter({}, { price: 180, changePct: 1, timestamp: 1 });
      const r = await router.getLiveQuote('AAPL.US');
      expect(r).toBeNull();
      expect(td.quoteCalls).toBe(0);
    });

    it('TD échoue (null) → null (caller retombe sur cascade EODHD/fallback)', async () => {
      const { router } = makeRouter({}, null);
      const r = await router.getLiveQuote('035720.KQ');
      expect(r).toBeNull();
    });

    it('TD renvoie un prix <= 0 → null (jamais de prix non fiable)', async () => {
      const { router } = makeRouter({}, { price: 0, changePct: 0, timestamp: 1 });
      const r = await router.getLiveQuote('000001.SHE');
      expect(r).toBeNull();
    });

    it('suffixe asie non couvert par TD (.HK/.T/.AU) → null (pas d’add-on TD)', async () => {
      // Le mapper td-symbol marque HK/T/AU comme UNSUPPORTED_TD_SUFFIXES →
      // convertToTdSymbol renvoie null → getLiveQuote null (ces marchés
      // restent sur EODHD, qui les couvre en intraday d’après les logs).
      const { router, td } = makeRouter({ LIVE_PRICE_TD_SUFFIXES: 'KO,KQ,SHG,SHE,HK' }, { price: 320, changePct: 1, timestamp: 1 });
      const r = await router.getLiveQuote('0700.HK');
      expect(r).toBeNull();
      expect(td.quoteCalls).toBe(0);
    });

    it('périmètre configurable par restriction (LIVE_PRICE_TD_SUFFIXES=KO) → .SHG hors scope', async () => {
      const { router, td } = makeRouter({ LIVE_PRICE_TD_SUFFIXES: 'KO' }, { price: 1500, changePct: 1, timestamp: 1 });
      expect(await router.getLiveQuote('600519.SHG')).toBeNull();
      expect(td.quoteCalls).toBe(0);
      expect(await router.getLiveQuote('005930.KO')).toEqual({ price: 1500, source: 'twelvedata' });
    });
  });
});
