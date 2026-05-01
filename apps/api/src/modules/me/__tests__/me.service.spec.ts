import { HttpException } from '@nestjs/common';
import { MeService } from '../me.service';

// ─── Minimal mock builder ─────────────────────────────────────────────────────

function makeChain(result: unknown = []) {
  const chain: Record<string, jest.Mock> = {};
  const methods = ['select', 'eq', 'limit', 'order', 'insert', 'update', 'maybeSingle', 'single', 'filter'];
  for (const m of methods) {
    chain[m] = jest.fn(() => chain);
  }
  // Make the chain awaitable — resolves to { data: result, error: null }
  const resolved = Promise.resolve({ data: result, error: null });
  (chain as unknown as { then: unknown }).then = resolved.then.bind(resolved);
  return chain;
}

function makeSupabase(overrides?: {
  getUser?: unknown;
  insertResult?: unknown;
  connectionsResult?: unknown;
  deleteUserResult?: unknown;
  updateResult?: unknown;
}) {
  const insertChain = makeChain(overrides?.insertResult ?? [{ id: 'audit-1' }]);
  const connectionsChain = makeChain(overrides?.connectionsResult ?? []);
  const updateChain = makeChain(null);

  // single() on insertChain
  insertChain.single = jest.fn().mockResolvedValue({
    data: overrides?.insertResult ?? { id: 'audit-1' },
    error: null,
  });

  const fromFn = jest.fn((table: string) => {
    if (table === 'account_deletion_audit') return insertChain;
    if (table === 'broker_connections') return connectionsChain;
    return updateChain;
  });

  return {
    getClient: () => ({
      from: fromFn,
      auth: {
        getUser: jest.fn().mockResolvedValue(overrides?.getUser ?? {
          data: { user: { id: 'user-123', email: 'test@example.com' } },
          error: null,
        }),
        admin: {
          deleteUser: jest.fn().mockResolvedValue(
            overrides?.deleteUserResult ?? { error: null },
          ),
        },
      },
    }),
  };
}

function makeVault() {
  return { clear: jest.fn().mockResolvedValue(undefined) };
}

// ─── validateToken ────────────────────────────────────────────────────────────

describe('MeService.validateToken', () => {
  it('returns userId + email on valid Bearer token', async () => {
    const svc = new MeService(makeSupabase() as never, makeVault() as never);
    const result = await svc.validateToken('Bearer valid-token');
    expect(result).toEqual({ userId: 'user-123', email: 'test@example.com' });
  });

  it('throws UnauthorizedException when no Bearer prefix', async () => {
    const svc = new MeService(makeSupabase() as never, makeVault() as never);
    await expect(svc.validateToken('token-only')).rejects.toThrow('Token Bearer manquant');
  });

  it('throws UnauthorizedException when getUser returns error', async () => {
    const sb = makeSupabase({ getUser: { data: { user: null }, error: { message: 'invalid' } } });
    const svc = new MeService(sb as never, makeVault() as never);
    await expect(svc.validateToken('Bearer bad')).rejects.toThrow('Token invalide ou expiré');
  });
});

// ─── checkDeleteRateLimit ─────────────────────────────────────────────────────

describe('MeService.checkDeleteRateLimit', () => {
  it('allows up to 3 attempts within the window', () => {
    const svc = new MeService(makeSupabase() as never, makeVault() as never);
    expect(() => svc.checkDeleteRateLimit('u1')).not.toThrow();
    expect(() => svc.checkDeleteRateLimit('u1')).not.toThrow();
    expect(() => svc.checkDeleteRateLimit('u1')).not.toThrow();
  });

  it('throws 429 on the 4th attempt within the window', () => {
    const svc = new MeService(makeSupabase() as never, makeVault() as never);
    svc.checkDeleteRateLimit('u2');
    svc.checkDeleteRateLimit('u2');
    svc.checkDeleteRateLimit('u2');
    expect(() => svc.checkDeleteRateLimit('u2')).toThrow(HttpException);
  });

  it('resets the window after the 60s window expires', () => {
    jest.useFakeTimers();
    const svc = new MeService(makeSupabase() as never, makeVault() as never);
    svc.checkDeleteRateLimit('u3');
    svc.checkDeleteRateLimit('u3');
    svc.checkDeleteRateLimit('u3');
    // Advance past the 60s window
    jest.advanceTimersByTime(61_000);
    expect(() => svc.checkDeleteRateLimit('u3')).not.toThrow();
    jest.useRealTimers();
  });

  it('tracks rate limits per user independently', () => {
    const svc = new MeService(makeSupabase() as never, makeVault() as never);
    svc.checkDeleteRateLimit('ua');
    svc.checkDeleteRateLimit('ua');
    svc.checkDeleteRateLimit('ua');
    // ua is at limit, but ub is fresh
    expect(() => svc.checkDeleteRateLimit('ub')).not.toThrow();
  });
});

// ─── hashIp ───────────────────────────────────────────────────────────────────

describe('MeService.hashIp', () => {
  it('returns sha256 hex for a known IP', () => {
    const hash = MeService.hashIp('127.0.0.1');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('returns undefined for undefined input', () => {
    expect(MeService.hashIp(undefined)).toBeUndefined();
  });

  it('is deterministic', () => {
    expect(MeService.hashIp('1.2.3.4')).toBe(MeService.hashIp('1.2.3.4'));
  });
});

// ─── deleteAccount ────────────────────────────────────────────────────────────

describe('MeService.deleteAccount', () => {
  it('purges vault refs and calls auth.admin.deleteUser', async () => {
    const deleteUserMock = jest.fn().mockResolvedValue({ error: null });
    const vaultClearMock = jest.fn().mockResolvedValue(undefined);

    const connectionChain = makeChain([{ credentials_vault_ref: 'vault-ref-1' }]);
    const auditChain = makeChain({ id: 'audit-1' });
    auditChain.single = jest.fn().mockResolvedValue({ data: { id: 'audit-1' }, error: null });

    const sb = {
      getClient: () => ({
        from: jest.fn((table: string) => {
          if (table === 'broker_connections') return connectionChain;
          return auditChain;
        }),
        auth: { admin: { deleteUser: deleteUserMock } },
      }),
    };
    const vault = { clear: vaultClearMock };
    const svc = new MeService(sb as never, vault as never);

    await svc.deleteAccount('user-123', 'test@example.com', '127.0.0.1');

    expect(vaultClearMock).toHaveBeenCalledWith('vault-ref-1');
    expect(deleteUserMock).toHaveBeenCalledWith('user-123');
  });

  it('marks audit as failed and re-throws when deleteUser fails', async () => {
    const deleteUserMock = jest.fn().mockResolvedValue({ error: { message: 'db error' } });
    const auditChain = makeChain({ id: 'audit-1' });
    auditChain.single = jest.fn().mockResolvedValue({ data: { id: 'audit-1' }, error: null });
    const connectionChain = makeChain([]);

    const updateMock = jest.fn(() => ({ eq: jest.fn().mockResolvedValue({ error: null }) }));
    const fromFn = jest.fn((table: string) => {
      if (table === 'broker_connections') return connectionChain;
      const chain = makeChain({ id: 'audit-1' });
      chain.single = jest.fn().mockResolvedValue({ data: { id: 'audit-1' }, error: null });
      chain.update = updateMock;
      return chain;
    });

    const sb = {
      getClient: () => ({
        from: fromFn,
        auth: { admin: { deleteUser: deleteUserMock } },
      }),
    };
    const svc = new MeService(sb as never, makeVault() as never);

    await expect(svc.deleteAccount('user-fail', undefined, undefined)).rejects.toThrow('auth.admin.deleteUser failed');
    expect(updateMock).toHaveBeenCalled();
  });

  it('does NOT expose credentials_vault_ref in broker_connections export', async () => {
    // Track which column string is passed to select() for broker_connections.
    let brokerSelectCols: string | undefined;
    const brokerChain = makeChain([]);
    const origSelect = brokerChain.select as jest.Mock;
    brokerChain.select = jest.fn((cols?: string) => {
      brokerSelectCols = cols;
      return origSelect.call(brokerChain, cols);
    });

    const defaultChain = makeChain(null);
    defaultChain.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });

    const sb = {
      getClient: () => ({
        from: jest.fn((table: string) => table === 'broker_connections' ? brokerChain : defaultChain),
        auth: { getUser: jest.fn() },
      }),
    };
    const svc = new MeService(sb as never, makeVault() as never);
    await svc.exportUserData('user-xyz');

    expect(brokerSelectCols).toBeDefined();
    expect(brokerSelectCols).not.toContain('credentials_vault_ref');
    expect(brokerSelectCols).not.toContain('*');
    expect(brokerSelectCols).toContain('provider');
  });
});
