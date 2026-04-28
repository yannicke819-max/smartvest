/**
 * PR E — Circuit breaker + body capture pour BinanceLiquidationsService.
 *
 * Vérifie :
 *  - parsing data Binance (préservation du comportement existant)
 *  - circuit breaker : 3 échecs consécutifs → cooldown 5min
 *  - body HTTP 4xx capturé dans le log warn (diagnostic)
 *  - succès reset le compteur d'échecs
 *  - en cooldown, getSnapshot() ne re-tape pas l'API et retourne empty
 *  - mapping symbol cas existants (BTC → BTCUSDT, etc.) — non régression
 *  - mapping invalid → null sans appel API
 */
import { BinanceLiquidationsService } from '../binance-liquidations.service';

describe('BinanceLiquidationsService — symbol mapping', () => {
  // Le mapping est appelé via getSnapshot dont on espionne le réseau via
  // global fetch mock. Pour le test pur du mapping, on utilise le fait
  // qu'un symbol invalide retourne null SANS faire de fetch.
  let svc: BinanceLiquidationsService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new BinanceLiquidationsService();
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns null + skips fetch on unmappable symbol', async () => {
    const r = await svc.getSnapshot('UNKNOWN-RANDOM');
    expect(r).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps BTC → BTCUSDT (cas réel prod 27/04)', async () => {
    await svc.getSnapshot('BTC');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = (fetchSpy.mock.calls[0][0] as string);
    expect(url).toContain('symbol=BTCUSDT');
  });

  it('maps ETH → ETHUSDT', async () => {
    await svc.getSnapshot('ETH');
    expect((fetchSpy.mock.calls[0][0] as string)).toContain('symbol=ETHUSDT');
  });

  it('maps BTCUSD → BTCUSDT (replace)', async () => {
    await svc.getSnapshot('BTCUSD');
    expect((fetchSpy.mock.calls[0][0] as string)).toContain('symbol=BTCUSDT');
  });
});

describe('BinanceLiquidationsService — parsing existing data shape', () => {
  let svc: BinanceLiquidationsService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new BinanceLiquidationsService();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('returns empty snapshot on []', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    const r = await svc.getSnapshot('BTC');
    expect(r).not.toBeNull();
    expect(r!.wavePattern).toBe('NONE');
    expect(r!.buyNotionalUsd1h).toBe(0);
  });

  it('detects LONG_PUKE on > $20M sell 1h + > 3× avg', async () => {
    const now = Date.now();
    const recent = now - 30 * 60 * 1000;  // 30 min ago
    const old1 = now - 8 * 3600_000;       // 8h ago
    const old2 = now - 12 * 3600_000;      // 12h ago

    // 3 SELL liquidations totalling $25M dans la dernière heure
    // 2 SELL liquidations à $1M each dans les 24h (baseline faible)
    const data = [
      { time: recent, side: 'SELL', origQty: 250, averagePrice: 100_000 }, // $25M
      { time: old1,   side: 'SELL', origQty: 10,  averagePrice: 100_000 }, // $1M
      { time: old2,   side: 'SELL', origQty: 10,  averagePrice: 100_000 }, // $1M
    ];
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(data), { status: 200 }),
    );

    const r = await svc.getSnapshot('BTC');
    expect(r!.wavePattern).toBe('LONG_PUKE');
    expect(r!.sellNotionalUsd1h).toBeCloseTo(25_000_000, -3);
  });

  it('detects LONG_SQUEEZE on > $20M buy 1h + > 3× avg', async () => {
    const now = Date.now();
    const data = [
      { time: now - 10 * 60_000, side: 'BUY', origQty: 220, averagePrice: 100_000 }, // $22M
      { time: now - 6 * 3600_000, side: 'BUY', origQty: 5, averagePrice: 100_000 },   // baseline
    ];
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(data), { status: 200 }),
    );

    const r = await svc.getSnapshot('BTC');
    expect(r!.wavePattern).toBe('LONG_SQUEEZE');
  });
});

describe('BinanceLiquidationsService — circuit breaker', () => {
  let svc: BinanceLiquidationsService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new BinanceLiquidationsService();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('not in cooldown initially', () => {
    expect(svc.isInCooldown('binance')).toBe(false);
    expect(svc.inspectCircuit('binance')).toBeNull();
  });

  it('1 fail does NOT trigger cooldown (under threshold 3)', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: -1121, msg: 'Invalid symbol.' }), { status: 400 }),
    );
    await svc.getSnapshot('BTC');
    expect(svc.isInCooldown('binance')).toBe(false);
    expect(svc.inspectCircuit('binance')!.consecutiveFailures).toBe(1);
  });

  it('triggers cooldown after exactly 3 consecutive HTTP 400 fails', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('Bad Request', { status: 400 }),
    );

    // 3 fails distincts (différents symbols pour bypass cache)
    await svc.getSnapshot('BTC');
    await svc.getSnapshot('ETH');
    await svc.getSnapshot('SOL');

    expect(svc.isInCooldown('binance')).toBe(true);
    const state = svc.inspectCircuit('binance')!;
    expect(state.consecutiveFailures).toBe(3);
    expect(state.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it('captures HTTP body in lastErrorMessage on 400 (diagnostic)', async () => {
    const errorBody = JSON.stringify({ code: -2014, msg: 'API-key format invalid.' });
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(errorBody, { status: 400 }),
    );

    await svc.getSnapshot('BTC');
    const state = svc.inspectCircuit('binance')!;
    expect(state.lastErrorMessage).toContain('HTTP_400');
    expect(state.lastErrorMessage).toContain('API-key format invalid');
  });

  it('does not call BINANCE fetch while in cooldown (saves rate limits)', async () => {
    // URL-aware mock : Binance fail, Bybit OK (Bybit n'entre pas en cooldown)
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (urlInput) => {
      const url = String(urlInput);
      if (url.includes('binance.com')) return new Response('Bad Request', { status: 400 });
      return new Response(
        JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [] } }),
        { status: 200 },
      );
    });

    // Trigger Binance cooldown (3 fails)
    await svc.getSnapshot('BTC');
    await svc.getSnapshot('ETH');
    await svc.getSnapshot('SOL');

    const binanceCallsBefore = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('binance.com'),
    ).length;
    expect(binanceCallsBefore).toBe(3);

    // Tentatives supplémentaires en cooldown : Binance NE doit PAS être
    // appelé (Bybit reste autorisé en fallback).
    await svc.getSnapshot('XRPUSD');
    await svc.getSnapshot('DOGEUSD');

    const binanceCallsAfter = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('binance.com'),
    ).length;
    expect(binanceCallsAfter).toBe(3); // Binance gelé, pas de nouveaux appels
  });

  it('returns empty snapshot (NOT null) while in cooldown so caller can degrade gracefully', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('Bad Request', { status: 400 }),
    );

    await svc.getSnapshot('BTC');
    await svc.getSnapshot('ETH');
    await svc.getSnapshot('SOL');

    // XRPUSD est mappable (→ XRPUSDT) — donc on traverse jusqu'au check
    // cooldown qui retourne empty. Avec un symbol unmappable (XRP nu),
    // on s'arrêterait avant à null — comportement orthogonal au cooldown.
    const r = await svc.getSnapshot('XRPUSD');
    expect(r).not.toBeNull();
    expect(r!.wavePattern).toBe('NONE');
    expect(r!.buyNotionalUsd1h).toBe(0);
  });

  it('resets failure counter on success after partial fails', async () => {
    // URL-aware mock pour cibler uniquement Binance dans le séquencement.
    // Bybit n'est pas sollicité tant que Binance n'est pas en cooldown
    // (cf. flow `if (!isInCooldown('binance'))` → succès → return).
    let binanceCallCount = 0;
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (urlInput) => {
      const url = String(urlInput);
      if (url.includes('binance.com')) {
        binanceCallCount++;
        // 1er + 2e appel = fail, 3e = succès (état 200 + array vide)
        if (binanceCallCount <= 2) return new Response('err', { status: 400 });
        return new Response(JSON.stringify([]), { status: 200 });
      }
      // Bybit jamais sollicité dans ce test (sécurité)
      return new Response(
        JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [] } }),
        { status: 200 },
      );
    });

    await svc.getSnapshot('BTC');
    await svc.getSnapshot('ETH');
    expect(svc.inspectCircuit('binance')!.consecutiveFailures).toBe(2);

    await svc.getSnapshot('SOL');
    expect(svc.inspectCircuit('binance')!.consecutiveFailures).toBe(0);
    expect(svc.isInCooldown('binance')).toBe(false);
  });

  it('exception (network error) counts as failure', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNRESET'));

    await svc.getSnapshot('BTC');
    await svc.getSnapshot('ETH');
    await svc.getSnapshot('SOL');
    expect(svc.isInCooldown('binance')).toBe(true);
    expect(svc.inspectCircuit('binance')!.lastErrorMessage).toContain('exception');
  });

  it('resetCircuit allows a recovery attempt', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('err', { status: 400 }),
    );

    await svc.getSnapshot('BTC');
    await svc.getSnapshot('ETH');
    await svc.getSnapshot('SOL');
    expect(svc.isInCooldown('binance')).toBe(true);

    svc.resetCircuit('binance');
    expect(svc.isInCooldown('binance')).toBe(false);
    expect(svc.inspectCircuit('binance')).toBeNull();
  });

  it('cooldown is per-provider (binance independent of others)', async () => {
    // Binance fail, Bybit OK → seul Binance entre en cooldown
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (urlInput) => {
      const url = String(urlInput);
      if (url.includes('binance.com')) {
        return new Response('err', { status: 400 });
      }
      // Bybit OK
      return new Response(
        JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [] } }),
        { status: 200 },
      );
    });

    await svc.getSnapshot('BTC');
    await svc.getSnapshot('ETH');
    await svc.getSnapshot('SOL');
    expect(svc.isInCooldown('binance')).toBe(true);
    expect(svc.isInCooldown('coinglass')).toBe(false); // jamais sollicité
    expect(svc.isInCooldown('bybit')).toBe(false);     // sollicité, succès → reset
  });
});

describe('BinanceLiquidationsService — Bybit fallback probe', () => {
  let svc: BinanceLiquidationsService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new BinanceLiquidationsService();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('probes Bybit recent-trade only when Binance is in cooldown', async () => {
    // Cycle 1-3 : Binance fail (no Bybit calls car pas en cooldown encore)
    // Cycle 4+ : Binance en cooldown → Bybit probe activé
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (urlInput) => {
      const url = String(urlInput);
      if (url.includes('binance.com')) {
        return new Response('err', { status: 400 });
      }
      return new Response(
        JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [] } }),
        { status: 200 },
      );
    });

    // 3 fails Binance → cooldown
    await svc.getSnapshot('BTC');
    await svc.getSnapshot('ETH');
    await svc.getSnapshot('SOL');
    const callsAfterCooldown = fetchSpy.mock.calls.length;

    // 4ᵉ appel : Binance en cooldown → Bybit probe
    await svc.getSnapshot('BTCUSD');
    const callsAfterBybit = fetchSpy.mock.calls.length;

    expect(callsAfterBybit).toBeGreaterThan(callsAfterCooldown);
    const bybitCallUrl = String(fetchSpy.mock.calls[callsAfterBybit - 1][0]);
    expect(bybitCallUrl).toContain('api.bybit.com/v5/market/recent-trade');
    expect(bybitCallUrl).toContain('category=linear');
    expect(bybitCallUrl).toContain('symbol=BTCUSDT');
  });

  it('records Bybit success on retCode=0', async () => {
    // Binance broken, Bybit OK
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (urlInput) => {
      const url = String(urlInput);
      if (url.includes('binance.com')) {
        return new Response('err', { status: 400 });
      }
      return new Response(
        JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [] } }),
        { status: 200 },
      );
    });

    await svc.getSnapshot('BTC');
    await svc.getSnapshot('ETH');
    await svc.getSnapshot('SOL');
    await svc.getSnapshot('BTCUSD'); // post-cooldown → Bybit probed

    expect(svc.inspectCircuit('bybit')?.consecutiveFailures ?? 0).toBe(0);
  });

  it('records Bybit failure on retCode != 0 (error envelope)', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (urlInput) => {
      const url = String(urlInput);
      if (url.includes('binance.com')) {
        return new Response('err', { status: 400 });
      }
      // Bybit returns HTTP 200 mais retCode error (typique Bybit V5)
      return new Response(
        JSON.stringify({ retCode: 10001, retMsg: 'Invalid symbol', result: null }),
        { status: 200 },
      );
    });

    // Force Binance cooldown puis 3 Bybit fails
    await svc.getSnapshot('BTC');
    await svc.getSnapshot('ETH');
    await svc.getSnapshot('SOL');
    await svc.getSnapshot('BTCUSD');
    await svc.getSnapshot('ETHUSD');
    await svc.getSnapshot('SOLUSD');

    const bybitState = svc.inspectCircuit('bybit')!;
    expect(bybitState.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(svc.isInCooldown('bybit')).toBe(true);
    expect(bybitState.lastErrorMessage).toContain('retCode_10001');
  });

  it('records Bybit failure on HTTP non-2xx', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (urlInput) => {
      const url = String(urlInput);
      if (url.includes('binance.com')) {
        return new Response('err', { status: 400 });
      }
      return new Response('Service Unavailable', { status: 503 });
    });

    await svc.getSnapshot('BTC');
    await svc.getSnapshot('ETH');
    await svc.getSnapshot('SOL');
    await svc.getSnapshot('BTCUSD');

    const bybitState = svc.inspectCircuit('bybit')!;
    expect(bybitState.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(bybitState.lastErrorMessage).toContain('HTTP_503');
  });

  it('Bybit returns empty snapshot regardless (no wave detection from trades)', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (urlInput) => {
      const url = String(urlInput);
      if (url.includes('binance.com')) {
        return new Response('err', { status: 400 });
      }
      return new Response(
        JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [] } }),
        { status: 200 },
      );
    });

    await svc.getSnapshot('BTC');
    await svc.getSnapshot('ETH');
    await svc.getSnapshot('SOL');
    const r = await svc.getSnapshot('BTCUSD');

    expect(r).not.toBeNull();
    // Trade volume ≠ liquidations → on n'invente pas de wave en fallback
    expect(r!.wavePattern).toBe('NONE');
    expect(r!.buyNotionalUsd1h).toBe(0);
  });
});

describe('BinanceLiquidationsService — summarize', () => {
  const svc = new BinanceLiquidationsService();

  it('returns "" on null snap', () => {
    expect(svc.summarize(null)).toBe('');
  });

  it('returns "" on quiet baseline', () => {
    expect(svc.summarize({
      symbol: 'BTC', asOf: Date.now(),
      buyNotionalUsd1h: 0.5e6, sellNotionalUsd1h: 0.3e6,
      buyNotionalUsd24h: 5e6, sellNotionalUsd24h: 3e6,
      wavePattern: 'NONE', waveDetail: '',
    })).toBe('');
  });

  it('emits LONG_PUKE marker', () => {
    const s = svc.summarize({
      symbol: 'BTC', asOf: Date.now(),
      buyNotionalUsd1h: 1e6, sellNotionalUsd1h: 25e6,
      buyNotionalUsd24h: 10e6, sellNotionalUsd24h: 30e6,
      wavePattern: 'LONG_PUKE', waveDetail: 'detail',
    });
    expect(s).toContain('LONG PUKE');
  });
});
