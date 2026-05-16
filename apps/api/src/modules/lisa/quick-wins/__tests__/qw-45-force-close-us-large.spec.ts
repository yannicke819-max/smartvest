import { Qw45ForceCloseUsLargeService } from '../qw-45-force-close-us-large.service';
import type { ConfigService } from '@nestjs/config';
import type { SupabaseService } from '../../../supabase/supabase.service';
import type { MechanicalTradingService } from '../../services/mechanical-trading.service';

interface SupabaseStubHandles {
  /** Résultat retourné par la chaîne `from(...).select(...).eq(...).eq(...).limit(...)`. */
  limit: jest.Mock;
}

function makeSupabaseStub(): { service: SupabaseService; handles: SupabaseStubHandles } {
  const limit = jest.fn().mockResolvedValue({ data: [], error: null });
  const eq2 = jest.fn(() => ({ limit }));
  const eq1 = jest.fn(() => ({ eq: eq2 }));
  const select = jest.fn(() => ({ eq: eq1 }));
  const from = jest.fn(() => ({ select }));
  const service = {
    isReady: jest.fn().mockReturnValue(true),
    getClient: jest.fn().mockReturnValue({ from }),
  } as unknown as SupabaseService;
  return { service, handles: { limit } };
}

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

function makeMechanical(): MechanicalTradingService & { forceClosePosition: jest.Mock } {
  return {
    forceClosePosition: jest.fn().mockResolvedValue(undefined),
  } as unknown as MechanicalTradingService & { forceClosePosition: jest.Mock };
}

describe('Qw45ForceCloseUsLargeService', () => {
  it('skips when QW45_FORCE_CLOSE_US_LARGE_ENABLED=false', async () => {
    const { service: supabase } = makeSupabaseStub();
    const mechanical = makeMechanical();
    const svc = new Qw45ForceCloseUsLargeService(
      makeConfig({ QW45_FORCE_CLOSE_US_LARGE_ENABLED: 'false' }),
      supabase,
      mechanical,
    );
    await svc.forceCloseUsLargePositions();
    expect(mechanical.forceClosePosition).not.toHaveBeenCalled();
  });

  it('skips and logs when 0 us_large positions open', async () => {
    const { service: supabase, handles } = makeSupabaseStub();
    handles.limit.mockResolvedValue({ data: [], error: null });
    const mechanical = makeMechanical();
    const svc = new Qw45ForceCloseUsLargeService(makeConfig({}), supabase, mechanical);
    await svc.forceCloseUsLargePositions();
    expect(mechanical.forceClosePosition).not.toHaveBeenCalled();
  });

  it('calls forceClosePosition once per open position with pre_ah_force_close', async () => {
    const { service: supabase, handles } = makeSupabaseStub();
    handles.limit.mockResolvedValue({
      data: [
        { id: 'pos-1', symbol: 'AAPL' },
        { id: 'pos-2', symbol: 'MSFT' },
        { id: 'pos-3', symbol: 'GOOGL' },
      ],
      error: null,
    });
    const mechanical = makeMechanical();
    const svc = new Qw45ForceCloseUsLargeService(makeConfig({}), supabase, mechanical);

    await svc.forceCloseUsLargePositions();

    expect(mechanical.forceClosePosition).toHaveBeenCalledTimes(3);
    expect(mechanical.forceClosePosition).toHaveBeenNthCalledWith(1, 'pos-1', 'pre_ah_force_close');
    expect(mechanical.forceClosePosition).toHaveBeenNthCalledWith(2, 'pos-2', 'pre_ah_force_close');
    expect(mechanical.forceClosePosition).toHaveBeenNthCalledWith(3, 'pos-3', 'pre_ah_force_close');
  });

  it('continues looping when a single forceClosePosition throws', async () => {
    const { service: supabase, handles } = makeSupabaseStub();
    handles.limit.mockResolvedValue({
      data: [
        { id: 'pos-1', symbol: 'AAPL' },
        { id: 'pos-2', symbol: 'MSFT' },
        { id: 'pos-3', symbol: 'GOOGL' },
      ],
      error: null,
    });
    const mechanical = makeMechanical();
    mechanical.forceClosePosition
      .mockRejectedValueOnce(new Error('livePrice unavailable'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const svc = new Qw45ForceCloseUsLargeService(makeConfig({}), supabase, mechanical);

    await svc.forceCloseUsLargePositions();

    expect(mechanical.forceClosePosition).toHaveBeenCalledTimes(3);
  });

  it('handles select error gracefully (no forceClosePosition call)', async () => {
    const { service: supabase, handles } = makeSupabaseStub();
    handles.limit.mockResolvedValue({
      data: null,
      error: { message: 'connection lost' },
    });
    const mechanical = makeMechanical();
    const svc = new Qw45ForceCloseUsLargeService(makeConfig({}), supabase, mechanical);

    await svc.forceCloseUsLargePositions();

    expect(mechanical.forceClosePosition).not.toHaveBeenCalled();
  });

  it('skips when supabase is not ready', async () => {
    const supabase = {
      isReady: jest.fn().mockReturnValue(false),
      getClient: jest.fn(),
    } as unknown as SupabaseService;
    const mechanical = makeMechanical();
    const svc = new Qw45ForceCloseUsLargeService(makeConfig({}), supabase, mechanical);

    await svc.forceCloseUsLargePositions();

    expect(mechanical.forceClosePosition).not.toHaveBeenCalled();
  });
});
