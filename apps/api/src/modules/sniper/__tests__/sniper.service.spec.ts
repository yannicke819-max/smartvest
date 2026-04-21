import { UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
import { SniperService } from '../sniper.service';

function buildSupabase(seed: { latest?: Record<string, unknown> | null; inserted?: Record<string, unknown> } = {}) {
  const table = {
    data: null as Record<string, unknown> | null,
    inserts: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
  };
  const client: Record<string, unknown> = {};

  const from = jest.fn().mockImplementation(() => {
    // New chain per call
    const select = jest.fn();
    const eq = jest.fn();
    const order = jest.fn();
    const limit = jest.fn();
    const maybeSingle = jest.fn();
    const single = jest.fn();
    const update = jest.fn();
    const insert = jest.fn();

    const chain = { select, eq, order, limit, maybeSingle, single, update, insert };
    select.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    order.mockReturnValue(chain);
    limit.mockReturnValue(chain);
    maybeSingle.mockResolvedValue({ data: seed.latest ?? null, error: null });
    single.mockResolvedValue({ data: seed.inserted ?? seed.latest ?? null, error: null });
    update.mockImplementation((u: Record<string, unknown>) => {
      table.updates.push(u);
      return chain;
    });
    insert.mockImplementation((i: Record<string, unknown>) => {
      table.inserts.push(i);
      return chain;
    });
    return chain;
  });

  client.from = from;
  return {
    service: { getClient: () => client },
    table,
    from,
  };
}

function buildConfig(overrides: Record<string, string | undefined> = {}) {
  return {
    get: (key: string) => overrides[key],
  };
}

function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
function pastIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe('SniperService', () => {
  describe('getStatus', () => {
    it('returns STANDARD when no session exists', async () => {
      const sb = buildSupabase({ latest: null });
      const svc = new SniperService(sb.service as never, buildConfig() as never);
      const status = await svc.getStatus('u1');
      expect(status.mode).toBe('STANDARD');
      expect(status.session).toBeNull();
      expect(status.secondsRemaining).toBeNull();
    });

    it('returns SNIPER_ACTIVE when session unlocked and not expired', async () => {
      const sb = buildSupabase({
        latest: {
          id: 's1', user_id: 'u1', status: 'unlocked', unlock_method: 'local_code',
          unlocked_at: pastIso(1), expires_at: futureIso(10), revoked_at: null,
          ttl_minutes: 15, created_at: pastIso(1), updated_at: pastIso(1),
        },
      });
      const svc = new SniperService(sb.service as never, buildConfig() as never);
      const status = await svc.getStatus('u1');
      expect(status.mode).toBe('SNIPER_ACTIVE');
      expect(status.secondsRemaining).toBeGreaterThan(500);
      expect(status.secondsRemaining).toBeLessThanOrEqual(600);
    });

    it('reconciles expired session to SNIPER_LOCKED', async () => {
      const sb = buildSupabase({
        latest: {
          id: 's1', user_id: 'u1', status: 'unlocked', unlock_method: 'local_code',
          unlocked_at: pastIso(30), expires_at: pastIso(5), revoked_at: null,
          ttl_minutes: 15, created_at: pastIso(30), updated_at: pastIso(30),
        },
      });
      const svc = new SniperService(sb.service as never, buildConfig() as never);
      const status = await svc.getStatus('u1');
      expect(status.mode).toBe('SNIPER_LOCKED');
      // Reconciliation wrote the update
      expect(sb.table.updates.some((u) => u.status === 'expired')).toBe(true);
    });

    it('returns SNIPER_LOCKED when latest session is revoked', async () => {
      const sb = buildSupabase({
        latest: {
          id: 's1', user_id: 'u1', status: 'revoked', unlock_method: 'local_code',
          unlocked_at: pastIso(60), expires_at: pastIso(30), revoked_at: pastIso(45),
          ttl_minutes: 15, created_at: pastIso(60), updated_at: pastIso(45),
        },
      });
      const svc = new SniperService(sb.service as never, buildConfig() as never);
      const status = await svc.getStatus('u1');
      expect(status.mode).toBe('SNIPER_LOCKED');
      expect(status.session?.status).toBe('revoked');
    });
  });

  describe('unlock', () => {
    it('throws BadRequest if no code is configured', async () => {
      const sb = buildSupabase();
      const svc = new SniperService(sb.service as never, buildConfig({ SNIPER_MODE_UNLOCK_CODE: undefined }) as never);
      await expect(svc.unlock('u1', 'whatever')).rejects.toThrow(BadRequestException);
    });

    it('throws Unauthorized on wrong code', async () => {
      const sb = buildSupabase();
      const svc = new SniperService(sb.service as never, buildConfig({ SNIPER_MODE_UNLOCK_CODE: 'abc' }) as never);
      await expect(svc.unlock('u1', 'wrong')).rejects.toThrow(UnauthorizedException);
    });

    it('creates a new unlocked session with correct TTL on valid code', async () => {
      const seeded = {
        id: 's1', user_id: 'u1', status: 'unlocked', unlock_method: 'local_code',
        unlocked_at: new Date().toISOString(), expires_at: futureIso(15), revoked_at: null,
        ttl_minutes: 15, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      const sb = buildSupabase({ inserted: seeded });
      const svc = new SniperService(
        sb.service as never,
        buildConfig({ SNIPER_MODE_UNLOCK_CODE: 'secret', SNIPER_MODE_TTL_MINUTES: '30' }) as never,
      );
      const session = await svc.unlock('u1', 'secret');
      expect(session.status).toBe('unlocked');
      // Revoked any pre-existing unlocked session before inserting
      expect(sb.table.updates.some((u) => u.status === 'revoked')).toBe(true);
      // Inserted with the env-configured TTL
      const inserted = sb.table.inserts[0];
      expect(inserted?.ttl_minutes).toBe(30);
    });

    it('accepts a per-request TTL override', async () => {
      const sb = buildSupabase({ inserted: {
        id: 's1', user_id: 'u1', status: 'unlocked', unlock_method: 'local_code',
        unlocked_at: new Date().toISOString(), expires_at: futureIso(45), revoked_at: null,
        ttl_minutes: 45, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      } });
      const svc = new SniperService(
        sb.service as never,
        buildConfig({ SNIPER_MODE_UNLOCK_CODE: 'secret' }) as never,
      );
      await svc.unlock('u1', 'secret', 45);
      expect(sb.table.inserts[0]?.ttl_minutes).toBe(45);
    });
  });

  describe('deactivate', () => {
    it('throws NotFound when there is no session', async () => {
      const sb = buildSupabase({ latest: null });
      const svc = new SniperService(sb.service as never, buildConfig() as never);
      await expect(svc.deactivate('u1')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when session is not unlocked', async () => {
      const sb = buildSupabase({
        latest: {
          id: 's1', user_id: 'u1', status: 'expired', unlock_method: 'local_code',
          unlocked_at: pastIso(60), expires_at: pastIso(30), revoked_at: null,
          ttl_minutes: 15, created_at: pastIso(60), updated_at: pastIso(30),
        },
      });
      const svc = new SniperService(sb.service as never, buildConfig() as never);
      await expect(svc.deactivate('u1')).rejects.toThrow(BadRequestException);
    });

    it('revokes the currently-unlocked session', async () => {
      const seeded = {
        id: 's1', user_id: 'u1', status: 'unlocked', unlock_method: 'local_code',
        unlocked_at: pastIso(5), expires_at: futureIso(10), revoked_at: null,
        ttl_minutes: 15, created_at: pastIso(5), updated_at: pastIso(5),
      };
      const sb = buildSupabase({ latest: seeded, inserted: { ...seeded, status: 'revoked', revoked_at: new Date().toISOString() } });
      const svc = new SniperService(sb.service as never, buildConfig() as never);
      const res = await svc.deactivate('u1');
      expect(res.status).toBe('revoked');
      expect(sb.table.updates.some((u) => u.status === 'revoked' && u.revoked_at)).toBe(true);
    });
  });
});
