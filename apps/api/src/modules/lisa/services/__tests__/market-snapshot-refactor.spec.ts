import { LisaService } from '../lisa.service';

/**
 * Refactor market_snapshot — tests Jest pour `isMacroTickerMarketOpen` et le
 * routing crypto via `fetchLivePriceForMacro`.
 *
 * Approche : on construit une instance LisaService partielle (les méthodes
 * testées n utilisent ni this.config, ni this.supabase, ni this.httpService).
 * Le constructor de LisaService a 30+ deps, on bypass via Object.create.
 */

function makeBareLisaService(): LisaService {
  const stub = Object.create(LisaService.prototype) as LisaService;
  // logEodhdCall : noop pour les tests qui exercent fetchLivePriceForMacro
  Object.assign(stub, { logEodhdCall: () => undefined });
  return stub;
}

describe('LisaService.isMacroTickerMarketOpen — refactor market_snapshot tâche B', () => {
  const service = makeBareLisaService();

  describe('FOREX (.FOREX) — 24/5 fermé samedi + dimanche avant 22h UTC', () => {
    it('skip FOREX samedi midi UTC', () => {
      const sat = new Date('2026-05-16T12:00:00Z'); // samedi
      expect(service.isMacroTickerMarketOpen('EURUSD.FOREX', sat)).toBe(false);
    });
    it('skip FOREX dimanche avant 22h UTC', () => {
      const sun = new Date('2026-05-17T20:00:00Z');
      expect(service.isMacroTickerMarketOpen('EURUSD.FOREX', sun)).toBe(false);
    });
    it('autorise FOREX dimanche 22h30 UTC (ouverture)', () => {
      const sun = new Date('2026-05-17T22:30:00Z');
      expect(service.isMacroTickerMarketOpen('USDJPY.FOREX', sun)).toBe(true);
    });
    it('autorise FOREX lundi midi UTC', () => {
      const mon = new Date('2026-05-18T12:00:00Z');
      expect(service.isMacroTickerMarketOpen('EURUSD.FOREX', mon)).toBe(true);
    });
    it('skip FOREX vendredi 22h05 UTC (clôture)', () => {
      const fri = new Date('2026-05-22T22:05:00Z');
      expect(service.isMacroTickerMarketOpen('EURUSD.FOREX', fri)).toBe(false);
    });
    it('autorise FOREX vendredi 21h55 UTC (juste avant clôture)', () => {
      const fri = new Date('2026-05-22T21:55:00Z');
      expect(service.isMacroTickerMarketOpen('EURUSD.FOREX', fri)).toBe(true);
    });
  });

  describe('Commodities (.COMM) — alignées sur forex', () => {
    it('skip XAUUSD.FOREX samedi (test sur classe .FOREX gold)', () => {
      // Note: gold est stocké en .FOREX dans le catalogue (XAUUSD.FOREX), pas .COMM.
      const sat = new Date('2026-05-16T08:00:00Z');
      expect(service.isMacroTickerMarketOpen('XAUUSD.FOREX', sat)).toBe(false);
    });
    it('skip une éventuelle .COMM samedi', () => {
      const sat = new Date('2026-05-16T08:00:00Z');
      expect(service.isMacroTickerMarketOpen('TEST.COMM', sat)).toBe(false);
    });
    it('autorise .COMM lundi midi', () => {
      const mon = new Date('2026-05-18T12:00:00Z');
      expect(service.isMacroTickerMarketOpen('TEST.COMM', mon)).toBe(true);
    });
  });

  describe('US equities (.US) — lun-ven 13h-21h UTC', () => {
    it('skip SPY.US samedi', () => {
      const sat = new Date('2026-05-16T15:00:00Z');
      expect(service.isMacroTickerMarketOpen('SPY.US', sat)).toBe(false);
    });
    it('skip SPY.US dimanche', () => {
      const sun = new Date('2026-05-17T15:00:00Z');
      expect(service.isMacroTickerMarketOpen('SPY.US', sun)).toBe(false);
    });
    it('skip SPY.US lundi 12h55 UTC (avant ouverture)', () => {
      const mon = new Date('2026-05-18T12:55:00Z');
      expect(service.isMacroTickerMarketOpen('SPY.US', mon)).toBe(false);
    });
    it('autorise SPY.US lundi 13h05 UTC', () => {
      const mon = new Date('2026-05-18T13:05:00Z');
      expect(service.isMacroTickerMarketOpen('SPY.US', mon)).toBe(true);
    });
    it('autorise QQQ.US lundi 20h55 UTC (post-market étendu)', () => {
      const mon = new Date('2026-05-18T20:55:00Z');
      expect(service.isMacroTickerMarketOpen('QQQ.US', mon)).toBe(true);
    });
    it('skip HYG.US lundi 22h UTC (hors plage)', () => {
      const mon = new Date('2026-05-18T22:00:00Z');
      expect(service.isMacroTickerMarketOpen('HYG.US', mon)).toBe(false);
    });
    it('skip LQD.US vendredi 23h UTC', () => {
      const fri = new Date('2026-05-22T23:00:00Z');
      expect(service.isMacroTickerMarketOpen('LQD.US', fri)).toBe(false);
    });
  });

  describe('Crypto (.CC) et indices Yahoo — toujours considérés ouverts', () => {
    it('crypto toujours ouvert (samedi 3h UTC)', () => {
      const sat = new Date('2026-05-16T03:00:00Z');
      expect(service.isMacroTickerMarketOpen('BTC-USD.CC', sat)).toBe(true);
    });
    it('crypto toujours ouvert (dimanche 20h UTC)', () => {
      const sun = new Date('2026-05-17T20:00:00Z');
      expect(service.isMacroTickerMarketOpen('ETH-USD.CC', sun)).toBe(true);
    });
    it('^VIX toujours ouvert (samedi)', () => {
      const sat = new Date('2026-05-16T03:00:00Z');
      expect(service.isMacroTickerMarketOpen('^VIX', sat)).toBe(true);
    });
    it('^TNX toujours ouvert (dimanche)', () => {
      const sun = new Date('2026-05-17T20:00:00Z');
      expect(service.isMacroTickerMarketOpen('^TNX', sun)).toBe(true);
    });
    it('DX-Y.NYB toujours ouvert (samedi)', () => {
      const sat = new Date('2026-05-16T03:00:00Z');
      expect(service.isMacroTickerMarketOpen('DX-Y.NYB', sat)).toBe(true);
    });
  });

  describe('Default — tickers non reconnus retournent true', () => {
    it('ticker inconnu samedi → true (ne pas filtrer agressivement)', () => {
      const sat = new Date('2026-05-16T03:00:00Z');
      expect(service.isMacroTickerMarketOpen('SOMETHING_UNKNOWN', sat)).toBe(true);
    });
  });
});

describe('LisaService.fetchLivePriceForMacro — refactor tâche C', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('retourne le close en cas de succès 200', async () => {
    const service = makeBareLisaService();
    const logSpy = jest.fn();
    Object.assign(service, { logEodhdCall: logSpy });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ close: 70000 }),
    } as unknown as Response);

    const v = await (service as unknown as {
      fetchLivePriceForMacro: (t: string, k: string) => Promise<number | null>;
    }).fetchLivePriceForMacro('BTC-USD.CC', 'test-key');

    expect(v).toBe(70000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('https://eodhd.com/api/real-time/BTC-USD.CC');
    expect(url).toContain('api_token=test-key');
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      ticker: 'BTC-USD.CC',
      calledBy: 'market_snapshot',
      success: true,
      priceUsd: 70000,
    }));
  });

  it('retourne null en cas d empty_price_field', async () => {
    const service = makeBareLisaService();
    const logSpy = jest.fn();
    Object.assign(service, { logEodhdCall: logSpy });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ close: 0 }),
    } as unknown as Response);

    const v = await (service as unknown as {
      fetchLivePriceForMacro: (t: string, k: string) => Promise<number | null>;
    }).fetchLivePriceForMacro('ETH-USD.CC', 'test-key');

    expect(v).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorMessage: 'empty_price_field',
    }));
  });

  it('retourne null en cas de HTTP 503 et log l erreur HTTP_*', async () => {
    const service = makeBareLisaService();
    const logSpy = jest.fn();
    Object.assign(service, { logEodhdCall: logSpy });

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as unknown as Response);

    const v = await (service as unknown as {
      fetchLivePriceForMacro: (t: string, k: string) => Promise<number | null>;
    }).fetchLivePriceForMacro('BTC-USD.CC', 'test-key');

    expect(v).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 503,
      errorMessage: 'HTTP_503',
    }));
  });

  it('retourne null sans throw en cas d exception fetch', async () => {
    const service = makeBareLisaService();
    const logSpy = jest.fn();
    Object.assign(service, { logEodhdCall: logSpy });

    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

    const v = await (service as unknown as {
      fetchLivePriceForMacro: (t: string, k: string) => Promise<number | null>;
    }).fetchLivePriceForMacro('BTC-USD.CC', 'test-key');

    expect(v).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorMessage: expect.stringContaining('network down'),
    }));
  });
});
