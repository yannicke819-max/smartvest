import { MeController } from '../me.controller';
import { MeService } from '../me.service';

function makeMeService(overrides?: Partial<MeService>): MeService {
  return {
    validateToken: jest.fn().mockResolvedValue({ userId: 'user-123', email: 'test@example.com' }),
    checkDeleteRateLimit: jest.fn(),
    exportUserData: jest.fn().mockResolvedValue({ schemaVersion: '1', userId: 'user-123' }),
    deleteAccount: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MeService;
}

function makeResponse() {
  const res = {
    setHeader: jest.fn(),
    send: jest.fn(),
  };
  return res;
}

// ─── GET /me/export ───────────────────────────────────────────────────────────

describe('MeController.export', () => {
  it('calls validateToken with Authorization header', async () => {
    const svc = makeMeService();
    const ctrl = new MeController(svc);
    const res = makeResponse();
    await ctrl.export({ authorization: 'Bearer tok' }, res as never);
    expect(svc.validateToken).toHaveBeenCalledWith('Bearer tok');
  });

  it('sets Content-Disposition to attachment', async () => {
    const svc = makeMeService();
    const ctrl = new MeController(svc);
    const res = makeResponse();
    await ctrl.export({ authorization: 'Bearer tok' }, res as never);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="smartvest-export.json"',
    );
  });

  it('sends JSON payload', async () => {
    const svc = makeMeService();
    const ctrl = new MeController(svc);
    const res = makeResponse();
    await ctrl.export({ authorization: 'Bearer tok' }, res as never);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining('"schemaVersion"'),
    );
  });

  it('propagates UnauthorizedException from validateToken', async () => {
    const { UnauthorizedException } = await import('@nestjs/common');
    const svc = makeMeService({
      validateToken: jest.fn().mockRejectedValue(new UnauthorizedException('Token invalide')),
    });
    const ctrl = new MeController(svc);
    await expect(ctrl.export({ authorization: 'Bearer bad' }, makeResponse() as never))
      .rejects.toThrow(UnauthorizedException);
  });
});

// ─── DELETE /me ───────────────────────────────────────────────────────────────

describe('MeController.deleteAccount', () => {
  it('calls validateToken then checkDeleteRateLimit then deleteAccount', async () => {
    const svc = makeMeService();
    const ctrl = new MeController(svc);
    await ctrl.deleteAccount({ authorization: 'Bearer tok', 'x-forwarded-for': '1.2.3.4' });
    expect(svc.validateToken).toHaveBeenCalledWith('Bearer tok');
    expect(svc.checkDeleteRateLimit).toHaveBeenCalledWith('user-123');
    expect(svc.deleteAccount).toHaveBeenCalledWith('user-123', 'test@example.com', '1.2.3.4');
  });

  it('extracts first IP from x-forwarded-for chain', async () => {
    const svc = makeMeService();
    const ctrl = new MeController(svc);
    await ctrl.deleteAccount({ authorization: 'Bearer tok', 'x-forwarded-for': '10.0.0.1, 1.2.3.4' });
    expect(svc.deleteAccount).toHaveBeenCalledWith('user-123', 'test@example.com', '10.0.0.1');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', async () => {
    const svc = makeMeService();
    const ctrl = new MeController(svc);
    await ctrl.deleteAccount({ authorization: 'Bearer tok', 'x-real-ip': '5.6.7.8' });
    expect(svc.deleteAccount).toHaveBeenCalledWith('user-123', 'test@example.com', '5.6.7.8');
  });

  it('propagates 429 from checkDeleteRateLimit', async () => {
    const { HttpException } = await import('@nestjs/common');
    const svc = makeMeService({
      checkDeleteRateLimit: jest.fn().mockImplementation(() => {
        throw new HttpException({ message: 'rate limit' }, 429);
      }),
    });
    const ctrl = new MeController(svc);
    await expect(ctrl.deleteAccount({ authorization: 'Bearer tok' })).rejects.toThrow(HttpException);
    expect(svc.deleteAccount).not.toHaveBeenCalled();
  });
});
