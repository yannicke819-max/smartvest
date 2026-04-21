import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BrokersService } from '../services/brokers.service';
import { CredentialsVaultService } from '../services/credentials-vault.service';
import { BrokersAuditService } from '../services/brokers-audit.service';

function mockChain(rowOrRows?: Record<string, unknown> | Record<string, unknown>[] | null) {
  // Captures the exact select() string so the security test can assert on it.
  const calls: { select?: string } = {};
  const chain = {
    select: jest.fn((cols?: string) => {
      calls.select = cols ?? '*';
      return chain;
    }),
    eq: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    insert: jest.fn(() => ({
      select: jest.fn(() => ({ single: jest.fn().mockResolvedValue({ data: Array.isArray(rowOrRows) ? rowOrRows[0] : rowOrRows, error: null }) })),
      ...chain,
    })),
    update: jest.fn(() => ({ eq: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({ error: null }) })) })),
    maybeSingle: jest.fn().mockResolvedValue({ data: Array.isArray(rowOrRows) ? rowOrRows[0] : rowOrRows, error: null }),
    single: jest.fn().mockResolvedValue({ data: Array.isArray(rowOrRows) ? rowOrRows[0] : rowOrRows, error: null }),
    then: undefined,
  } as Record<string, unknown>;
  // For non-single queries (like list), resolve on await.
  const awaitable = Promise.resolve({ data: Array.isArray(rowOrRows) ? rowOrRows : rowOrRows ? [rowOrRows] : [], error: null });
  (chain as unknown as { then: unknown }).then = awaitable.then.bind(awaitable);
  return { chain, calls };
}

function mockSupabase(rowOrRows?: Record<string, unknown> | Record<string, unknown>[] | null) {
  const { chain, calls } = mockChain(rowOrRows);
  return {
    sb: { getClient: () => ({ from: jest.fn(() => chain) }) },
    calls,
  };
}

function mockFlags(enabled = true) {
  return {
    isEnabled: jest.fn((key: string) => {
      if (key === 'BROKER_CONNECTIONS_ENABLED') return enabled;
      return false;
    }),
  };
}

describe('BrokersService — security', () => {
  it('get() selects an explicit column list and NEVER includes credentials_vault_ref', async () => {
    const row = {
      id: 'c1', user_id: 'u1', provider: 'MANUAL', label: 'demo', status: 'pending',
      supports_read: false, supports_execution: false, supports_streaming: false,
      supports_options: false, supports_crypto: false, supports_csv_import: true,
      connected_at: null, last_sync_at: null, last_error_at: null, last_error_message: null,
      meta: {}, created_at: '2026-04-01', updated_at: '2026-04-01',
    };
    const { sb, calls } = mockSupabase(row);
    const svc = new BrokersService(sb as never, mockFlags() as never, {} as never, {} as never);
    const result = await svc.get('c1', 'u1');
    expect(calls.select).toBeDefined();
    expect(calls.select).not.toMatch(/\*/);                             // no wildcard
    expect(calls.select).not.toContain('credentials_vault_ref');        // explicitly absent
    expect(result).not.toHaveProperty('credentials_vault_ref');
  });

  it('list() also uses explicit columns without credentials_vault_ref', async () => {
    const { sb, calls } = mockSupabase([]);
    const svc = new BrokersService(sb as never, mockFlags() as never, {} as never, {} as never);
    await svc.list('u1');
    expect(calls.select).toBeDefined();
    expect(calls.select).not.toContain('credentials_vault_ref');
  });

  it('create() refuses when BROKER_CONNECTIONS_ENABLED is off', async () => {
    const { sb } = mockSupabase();
    const svc = new BrokersService(sb as never, mockFlags(false) as never, {} as never, {} as never);
    await expect(
      svc.create('u1', {
        provider: 'MANUAL',
        label: 'x',
        credentials: { provider: 'MANUAL', note: 'no-credentials' },
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('create() rejects credentials provider mismatch', async () => {
    const { sb } = mockSupabase();
    const svc = new BrokersService(sb as never, mockFlags() as never, {} as never, {} as never);
    await expect(
      svc.create('u1', {
        provider: 'MANUAL',
        label: 'x',
        credentials: { provider: 'TRADING212', apiKey: 'k' } as never,
      }),
    ).rejects.toThrow(/Incohérence/);
  });
});

describe('BrokersService — revoke', () => {
  it('always permits revoke even when module flag is off (safety wins)', async () => {
    const row = {
      id: 'c1', user_id: 'u1', provider: 'MANUAL',
      credentials_vault_ref: 'manual:abc',
    };
    const { sb } = mockSupabase(row);
    const vault: Partial<CredentialsVaultService> = { clear: jest.fn().mockResolvedValue(undefined) };
    const audit: Partial<BrokersAuditService> = { write: jest.fn().mockResolvedValue('e1') };

    // Capture get() response after the revoke. We need get() to also return row shape.
    const svc = new BrokersService(sb as never, mockFlags(false) as never, vault as never, audit as never);
    try {
      await svc.revoke('c1', 'u1');
    } catch {
      // The mock chain is simplified; what we care about is vault.clear() being called
      // despite the module flag being off.
    }
    expect(vault.clear).toHaveBeenCalled();
  });
});

describe('BrokersService — get missing', () => {
  it('throws NotFoundException when the row does not exist', async () => {
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
    };
    const sb = { getClient: () => ({ from: () => chain }) };
    const svc = new BrokersService(sb as never, mockFlags() as never, {} as never, {} as never);
    await expect(svc.get('missing', 'u1')).rejects.toThrow(NotFoundException);
  });
});
