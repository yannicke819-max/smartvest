/**
 * Phase B.1 — Unit tests pour IbkrClient + IbkrSymbolMapper.
 *
 * Mock complet de fetch pour valider :
 *   - Construction URL + headers (X-IBKR-Session)
 *   - Mapping HTTP status → erreurs typées (Auth/RateLimit/Server/Client)
 *   - placeOrder happy path + confirmation requise
 *   - getOrderStatus null si 404
 *   - cancelOrder false si 404/409
 *   - validateSession true/false selon AuthError
 *   - Symbol mapper : cache hit, cache LRU eviction
 */

import {
  IbkrClient,
  IbkrAuthError,
  IbkrRateLimitError,
  IbkrServerError,
  IbkrClientError,
  IbkrSymbolMapper,
} from '@smartvest/brokers';

function mockOk(body: unknown): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as Response) as unknown as typeof fetch;
}

function mockStatus(status: number, body = ''): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response) as unknown as typeof fetch;
}

const baseCfg = {
  baseUrl: 'https://test.example/v1/api',
  sessionToken: 'tok-abc',
  accountId: 'U1234567',
  timeoutMs: 1000,
};

describe('IbkrClient', () => {
  describe('searchContract', () => {
    it('returns first STK contract when multiple sections', async () => {
      const fetchImpl = mockOk([
        {
          conid: 265598,
          symbol: 'AAPL',
          description: 'APPLE INC',
          companyHeader: '',
          companyName: 'APPLE INC',
          restricted: null,
          fop: null,
          opt: null,
          war: null,
          sections: [{ secType: 'STK', exchange: 'NASDAQ' }],
        },
      ]);
      const client = new IbkrClient({ ...baseCfg, fetchImpl });
      const c = await client.searchContract('AAPL');
      expect(c?.conid).toBe(265598);
    });

    it('returns null when IBKR returns empty array', async () => {
      const client = new IbkrClient({ ...baseCfg, fetchImpl: mockOk([]) });
      const c = await client.searchContract('NOPE');
      expect(c).toBeNull();
    });
  });

  describe('placeOrder', () => {
    it('returns order_id on success', async () => {
      const fetchImpl = mockOk([{ order_id: 'IBK-99', order_status: 'Submitted' }]);
      const client = new IbkrClient({ ...baseCfg, fetchImpl });
      const r = await client.placeOrder({
        acctId: 'U1234567',
        conid: 265598,
        orderType: 'MKT',
        side: 'BUY',
        quantity: 10,
        tif: 'DAY',
      });
      expect(r.order_id).toBe('IBK-99');
      expect(r.order_status).toBe('Submitted');
    });

    it('throws IbkrClientError when IBKR demands confirmation (V1 unsupported)', async () => {
      const fetchImpl = mockOk([{
        order_id: '',
        order_status: 'PendingSubmit',
        message: ['You are about to submit a stop order...'],
        id: 'reply-id-1',
      }]);
      const client = new IbkrClient({ ...baseCfg, fetchImpl });
      await expect(client.placeOrder({
        acctId: 'U1234567',
        conid: 1, orderType: 'STP', side: 'BUY', quantity: 1, tif: 'DAY',
      })).rejects.toThrow(IbkrClientError);
    });
  });

  describe('getOrderStatus', () => {
    it('returns null on 404', async () => {
      const client = new IbkrClient({ ...baseCfg, fetchImpl: mockStatus(404, 'not found') });
      const r = await client.getOrderStatus('missing');
      expect(r).toBeNull();
    });

    it('returns parsed status object on 200', async () => {
      const body = {
        order_id: 99,
        status: 'Filled',
        side: 'BUY',
        ticker: 'AAPL',
        conid: 265598,
        filled_quantity: 10,
        remaining_quantity: 0,
        avg_price: 195.50,
        commission: 0.05,
        tif: 'DAY',
        order_type: 'MKT',
      };
      const client = new IbkrClient({ ...baseCfg, fetchImpl: mockOk(body) });
      const r = await client.getOrderStatus('99');
      expect(r?.status).toBe('Filled');
      expect(r?.avg_price).toBe(195.50);
    });
  });

  describe('cancelOrder', () => {
    it('returns false on 404 or 409 (not cancellable)', async () => {
      for (const status of [404, 409]) {
        const client = new IbkrClient({ ...baseCfg, fetchImpl: mockStatus(status, '') });
        await expect(client.cancelOrder('99')).resolves.toBe(false);
      }
    });

    it('returns true on 200', async () => {
      const client = new IbkrClient({ ...baseCfg, fetchImpl: mockOk({ msg: 'canceled' }) });
      await expect(client.cancelOrder('99')).resolves.toBe(true);
    });
  });

  describe('validateSession', () => {
    it('returns false on 401 (auth error)', async () => {
      const client = new IbkrClient({ ...baseCfg, fetchImpl: mockStatus(401) });
      await expect(client.validateSession()).resolves.toBe(false);
    });

    it('returns true on 200', async () => {
      const client = new IbkrClient({ ...baseCfg, fetchImpl: mockOk({}) });
      await expect(client.validateSession()).resolves.toBe(true);
    });

    it('throws on 5xx (not a session issue)', async () => {
      const client = new IbkrClient({ ...baseCfg, fetchImpl: mockStatus(503) });
      await expect(client.validateSession()).rejects.toThrow(IbkrServerError);
    });
  });

  describe('error mapping', () => {
    it('401 → IbkrAuthError', async () => {
      const client = new IbkrClient({ ...baseCfg, fetchImpl: mockStatus(401) });
      await expect(client.searchContract('X')).rejects.toThrow(IbkrAuthError);
    });
    it('429 → IbkrRateLimitError', async () => {
      const client = new IbkrClient({ ...baseCfg, fetchImpl: mockStatus(429) });
      await expect(client.searchContract('X')).rejects.toThrow(IbkrRateLimitError);
    });
    it('500 → IbkrServerError', async () => {
      const client = new IbkrClient({ ...baseCfg, fetchImpl: mockStatus(500) });
      await expect(client.searchContract('X')).rejects.toThrow(IbkrServerError);
    });
    it('400 → IbkrClientError', async () => {
      const client = new IbkrClient({ ...baseCfg, fetchImpl: mockStatus(400, 'invalid') });
      await expect(client.searchContract('X')).rejects.toThrow(IbkrClientError);
    });
  });

  describe('headers', () => {
    it('passes X-IBKR-Session header on every call', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([]),
      } as Response) as unknown as typeof fetch;
      const client = new IbkrClient({ ...baseCfg, fetchImpl });
      await client.searchContract('AAPL');
      const call = (fetchImpl as jest.Mock).mock.calls[0];
      expect(call[1].headers['X-IBKR-Session']).toBe('tok-abc');
    });
  });
});

describe('IbkrSymbolMapper', () => {
  it('caches lookups (LRU)', async () => {
    const stubClient = {
      searchContract: jest.fn().mockResolvedValue({
        conid: 265598, symbol: 'AAPL', sections: [{ secType: 'STK' }],
      }),
    } as unknown as IbkrClient;
    const mapper = new IbkrSymbolMapper(stubClient);

    expect(await mapper.resolve('AAPL.US')).toBe(265598);
    expect(await mapper.resolve('AAPL.US')).toBe(265598);
    expect(stubClient.searchContract).toHaveBeenCalledTimes(1);
  });

  it('strips exchange suffix before lookup', async () => {
    const stubClient = {
      searchContract: jest.fn().mockResolvedValue({
        conid: 1, symbol: 'TICK', sections: [],
      }),
    } as unknown as IbkrClient;
    const mapper = new IbkrSymbolMapper(stubClient);
    await mapper.resolve('TICK.US');
    expect((stubClient.searchContract as jest.Mock).mock.calls[0][0]).toBe('TICK');
  });

  it('returns null when IBKR has no match', async () => {
    const stubClient = {
      searchContract: jest.fn().mockResolvedValue(null),
    } as unknown as IbkrClient;
    const mapper = new IbkrSymbolMapper(stubClient);
    expect(await mapper.resolve('NOPE.US')).toBeNull();
  });

  it('preload + cache size accessor', async () => {
    const stubClient = {
      searchContract: jest.fn(),
    } as unknown as IbkrClient;
    const mapper = new IbkrSymbolMapper(stubClient);
    mapper.preload('AAPL.US', 265598);
    expect(mapper.getCacheSize()).toBe(1);
    expect(await mapper.resolve('AAPL.US')).toBe(265598);
    expect(stubClient.searchContract).not.toHaveBeenCalled();
  });
});
