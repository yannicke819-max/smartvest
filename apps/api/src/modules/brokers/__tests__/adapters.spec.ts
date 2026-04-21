import {
  ManualAdapter,
  InteractiveBrokersAdapter,
  SaxoAdapter,
  DegiroAdapter,
  Trading212Adapter,
  createBrokerAdapter,
  NotSupportedError,
  AdapterStubError,
  type AdapterFactoryFlags,
} from '@smartvest/brokers';

const allFlagsOn: AdapterFactoryFlags = {
  BROKER_CONNECTIONS_ENABLED: true,
  BROKER_ADAPTER_IB_ENABLED: true,
  BROKER_ADAPTER_SAXO_ENABLED: true,
  BROKER_ADAPTER_DEGIRO_ENABLED: true,
  BROKER_ADAPTER_TRADING212_ENABLED: true,
};

describe('ManualAdapter', () => {
  const a = new ManualAdapter();
  it('supports connect with MANUAL credentials', async () => {
    await expect(a.connect({ provider: 'MANUAL', note: 'no-credentials' })).resolves.toBeUndefined();
  });
  it('rejects non-MANUAL credentials', async () => {
    await expect(a.connect({ provider: 'TRADING212', apiKey: 'x' } as never)).rejects.toThrow();
  });
  it('returns empty arrays on sync endpoints', async () => {
    expect(await a.fetchPositions()).toEqual([]);
    expect(await a.fetchCash()).toEqual([]);
    expect(await a.fetchTransactions()).toEqual([]);
  });
  it('testConnection succeeds locally', async () => {
    expect(await a.testConnection()).toMatchObject({ ok: true });
  });
  it('placeOrder throws NotSupportedError', async () => {
    await expect(
      a.placeOrder({ accountIdExternal: 'x', instrumentRef: 'y', side: 'buy', orderType: 'market', quantity: '1' }),
    ).rejects.toThrow(NotSupportedError);
  });
});

describe('InteractiveBrokersAdapter (stub)', () => {
  const a = new InteractiveBrokersAdapter();
  it('connect accepts valid IB credentials', async () => {
    await expect(
      a.connect({ provider: 'INTERACTIVE_BROKERS', accountId: 'U1234567', sessionToken: 'tok' }),
    ).resolves.toBeUndefined();
  });
  it('live fetches throw AdapterStubError', async () => {
    await expect(a.fetchPositions()).rejects.toThrow(AdapterStubError);
    await expect(a.fetchCash()).rejects.toThrow(AdapterStubError);
    await expect(a.fetchTransactions()).rejects.toThrow(AdapterStubError);
  });
  it('placeOrder throws NotSupportedError', async () => {
    await expect(
      a.placeOrder({ accountIdExternal: 'x', instrumentRef: 'y', side: 'buy', orderType: 'market', quantity: '1' }),
    ).rejects.toThrow(NotSupportedError);
  });
});

describe('SaxoAdapter (stub)', () => {
  const a = new SaxoAdapter();
  it('rejects expired OAuth token', async () => {
    await expect(
      a.connect({
        provider: 'SAXO', oauthAccessToken: 'a', oauthRefreshToken: 'r',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).rejects.toThrow(/expiré/);
  });
  it('accepts a fresh token', async () => {
    await expect(
      a.connect({
        provider: 'SAXO', oauthAccessToken: 'a', oauthRefreshToken: 'r',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    ).resolves.toBeUndefined();
  });
  it('live fetches throw AdapterStubError', async () => {
    await expect(a.fetchPositions()).rejects.toThrow(AdapterStubError);
  });
});

describe('DegiroAdapter (always CSV redirect)', () => {
  const a = new DegiroAdapter();
  it('connect rejects with CSV redirect message', async () => {
    await expect(a.connect({ provider: 'DEGIRO', note: 'use-csv-import' })).rejects.toThrow(/CSV/);
  });
  it('all live methods redirect to /imports', async () => {
    await expect(a.fetchPositions()).rejects.toThrow(/CSV/);
    await expect(a.fetchCash()).rejects.toThrow(/CSV/);
    await expect(a.fetchTransactions()).rejects.toThrow(/CSV/);
  });
  it('testConnection returns ok:false with CSV redirect', async () => {
    const r = await a.testConnection();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/CSV/);
  });
});

describe('Trading212Adapter (stub)', () => {
  const a = new Trading212Adapter();
  it('connect accepts api key', async () => {
    await expect(a.connect({ provider: 'TRADING212', apiKey: 'k' })).resolves.toBeUndefined();
  });
  it('live fetches throw AdapterStubError', async () => {
    await expect(a.fetchCash()).rejects.toThrow(AdapterStubError);
  });
});

describe('createBrokerAdapter factory', () => {
  it('throws when master gate is off', () => {
    expect(() =>
      createBrokerAdapter('MANUAL', { ...allFlagsOn, BROKER_CONNECTIONS_ENABLED: false }),
    ).toThrow(NotSupportedError);
  });
  it('MANUAL always allowed when master gate on', () => {
    expect(createBrokerAdapter('MANUAL', allFlagsOn)).toBeInstanceOf(ManualAdapter);
  });
  it('refuses IB when adapter flag off', () => {
    expect(() =>
      createBrokerAdapter('INTERACTIVE_BROKERS', { ...allFlagsOn, BROKER_ADAPTER_IB_ENABLED: false }),
    ).toThrow(/IB/);
  });
  it('returns DegiroAdapter regardless of flag (stub instance)', () => {
    expect(createBrokerAdapter('DEGIRO', { ...allFlagsOn, BROKER_ADAPTER_DEGIRO_ENABLED: false })).toBeInstanceOf(DegiroAdapter);
  });
  it('refuses BOURSE_DIRECT / FORTUNEO (no public API)', () => {
    expect(() => createBrokerAdapter('BOURSE_DIRECT', allFlagsOn)).toThrow(/API publique/);
    expect(() => createBrokerAdapter('FORTUNEO', allFlagsOn)).toThrow(/API publique/);
  });
});
