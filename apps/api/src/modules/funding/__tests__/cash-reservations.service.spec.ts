import { ConflictException, NotFoundException } from '@nestjs/common';
import { CashReservationsService } from '../services/cash-reservations.service';

function chainMock(single?: unknown) {
  const chain: Record<string, jest.Mock> = {};
  chain['select'] = jest.fn().mockReturnValue(chain);
  chain['eq'] = jest.fn().mockReturnValue(chain);
  chain['order'] = jest.fn().mockResolvedValue({ data: [], error: null });
  chain['insert'] = jest.fn().mockResolvedValue({ error: null });
  chain['update'] = jest.fn().mockReturnValue({
    eq: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) }),
  });
  chain['single'] = jest.fn().mockResolvedValue({ data: single, error: null });
  chain['maybeSingle'] = jest.fn().mockResolvedValue({ data: single, error: null });
  return chain;
}

function buildSupabase(opts: {
  balance?: { settled: string; reserved: string };
  reservation?: Record<string, unknown> | null;
}) {
  const balanceChain = chainMock(opts.balance ? { settled: opts.balance.settled, reserved: opts.balance.reserved } : null);
  const reservationChain = chainMock(opts.reservation ?? null);
  const client = {
    from: jest.fn((table: string) => (table === 'cash_balances' ? balanceChain : reservationChain)),
  };
  return {
    supabase: { getClient: jest.fn().mockReturnValue(client) },
    balanceChain,
    reservationChain,
  };
}

function buildLedger() {
  return { record: jest.fn().mockResolvedValue('ledger-id'), adjustPendingIn: jest.fn() };
}
function buildAudit() {
  return { write: jest.fn().mockResolvedValue('audit-id'), listForTransfer: jest.fn() };
}

describe('CashReservationsService', () => {
  describe('create', () => {
    it('creates a reservation when enough cash is available', async () => {
      const { supabase, reservationChain } = buildSupabase({
        balance: { settled: '1000', reserved: '200' },
        reservation: { id: 'r1', status: 'active', destination_id: 'd1', currency: 'EUR', amount: '300', reason: 'goal' },
      });
      const ledger = buildLedger();
      const audit = buildAudit();
      const svc = new CashReservationsService(supabase as any, ledger as any, audit as any);

      await svc.create('u1', {
        destinationId: 'd1', currency: 'EUR', amount: '300', reason: 'Objectif retraite',
      });

      expect(reservationChain.insert).toHaveBeenCalled();
      expect(ledger.record).toHaveBeenCalledWith(
        expect.objectContaining({ movementType: 'reservation', amount: '300' }),
      );
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reservation_created' }));
    });

    it('throws ConflictException when available cash is insufficient', async () => {
      const { supabase } = buildSupabase({
        balance: { settled: '500', reserved: '450' },
      });
      const svc = new CashReservationsService(supabase as any, buildLedger() as any, buildAudit() as any);

      await expect(
        svc.create('u1', {
          destinationId: 'd1', currency: 'EUR', amount: '100', reason: 'test',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('treats a missing balance row as zero available', async () => {
      const { supabase } = buildSupabase({});
      const svc = new CashReservationsService(supabase as any, buildLedger() as any, buildAudit() as any);

      await expect(
        svc.create('u1', {
          destinationId: 'd1', currency: 'EUR', amount: '1', reason: 'test',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('release', () => {
    it('releases an active reservation and records a ledger release', async () => {
      const { supabase } = buildSupabase({
        reservation: { id: 'r1', status: 'active', destination_id: 'd1', currency: 'EUR', amount: '300', reason: 'goal' },
      });
      const ledger = buildLedger();
      const audit = buildAudit();
      const svc = new CashReservationsService(supabase as any, ledger as any, audit as any);

      await svc.release('r1', 'u1');

      expect(ledger.record).toHaveBeenCalledWith(
        expect.objectContaining({ movementType: 'reservation_release', amount: '300' }),
      );
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reservation_released' }));
    });

    it('refuses to release a non-active reservation', async () => {
      const { supabase } = buildSupabase({
        reservation: { id: 'r1', status: 'released', destination_id: 'd1', currency: 'EUR', amount: '300', reason: 'goal' },
      });
      const svc = new CashReservationsService(supabase as any, buildLedger() as any, buildAudit() as any);
      await expect(svc.release('r1', 'u1')).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException when the reservation does not exist', async () => {
      const { supabase, reservationChain } = buildSupabase({ reservation: null });
      reservationChain['single'] = jest
        .fn()
        .mockResolvedValue({ data: null, error: { message: 'not found' } });
      const svc = new CashReservationsService(supabase as any, buildLedger() as any, buildAudit() as any);
      await expect(svc.release('r-404', 'u1')).rejects.toThrow(NotFoundException);
    });
  });
});
