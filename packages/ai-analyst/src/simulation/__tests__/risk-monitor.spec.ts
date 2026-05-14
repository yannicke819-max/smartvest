/**
 * Bug #M (14/05/2026) — Tests garde-fou anti-prix-0 dans RiskMonitorService.
 *
 * Incident reproductible : 14/05 09:54 UTC, position SEE.LSE clôturée à
 * exit_price=0.0000 sur SL trigger faussé. Perte -$1574.18 / -99.95%.
 *
 * Cause racine : le producer lisa.service.ts retourne un sentinel
 * { price: '0', source: 'fallback_unknown' } quand le symbole est inconnu
 * de la table fallback. Le consumer risk-monitor n'appliquait AUCUNE garde
 * → new Decimal('0') ≤ stopLossPrice → close à 0.
 *
 * Fix : checkPositionLimits skippe le cycle si source commence par 'fallback'
 * OU si livePrice est zero/negative/non-finite.
 */

import { RiskMonitorService } from '../risk-monitor.service';

describe('Bug #M — fallback price guard (RiskMonitorService.checkPositionLimits)', () => {
  let mockBroker: { closePosition: jest.Mock; getPositions: jest.Mock };
  // Supabase n'est pas exercé par checkPositionLimits — mock minimal.
  const mockSupabase = { from: jest.fn() } as never;

  beforeEach(() => {
    mockBroker = {
      closePosition: jest.fn().mockResolvedValue({ id: 'p1' }),
      getPositions: jest.fn().mockResolvedValue([]),
    };
  });

  it('does NOT close position when fetchLivePrice returns price=0 source=fallback_unknown', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ price: '0', source: 'fallback_unknown' });
    const svc = new RiskMonitorService(mockSupabase, mockBroker as never, mockFetch);
    const pos = {
      id: 'p1', symbol: 'SEE.LSE', direction: 'long',
      entryPrice: '5.01', stopLossPrice: '4.89', takeProfitPrice: '5.14',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).checkPositionLimits(pos, { actionsApplied: [], violations: [] });
    expect(mockBroker.closePosition).not.toHaveBeenCalled();
  });

  it('does NOT close position when fetchLivePrice returns price="NaN"', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ price: 'NaN', source: 'eodhd' });
    const svc = new RiskMonitorService(mockSupabase, mockBroker as never, mockFetch);
    const pos = {
      id: 'p2', symbol: 'AAA.US', direction: 'long',
      entryPrice: '10', stopLossPrice: '9.5', takeProfitPrice: '11',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).checkPositionLimits(pos, { actionsApplied: [], violations: [] });
    expect(mockBroker.closePosition).not.toHaveBeenCalled();
  });

  it('DOES close position on legitimate stop trigger (source=eodhd, price < SL)', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ price: '4.80', source: 'eodhd' });
    const svc = new RiskMonitorService(mockSupabase, mockBroker as never, mockFetch);
    const pos = {
      id: 'p3', symbol: 'BBB.US', direction: 'long',
      entryPrice: '5.01', stopLossPrice: '4.89', takeProfitPrice: '5.14',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).checkPositionLimits(pos, { actionsApplied: [], violations: [] });
    expect(mockBroker.closePosition).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'closed_stop' }),
    );
  });
});
