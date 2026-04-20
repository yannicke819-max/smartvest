import { BadRequestException } from '@nestjs/common';
import { CashLedgerService } from '../services/cash-ledger.service';

function buildSupabase(initialBalance: Record<string, unknown> | null) {
  const balanceChain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: initialBalance, error: null }),
    upsert: jest.fn().mockResolvedValue({ error: null }),
  };
  const ledgerChain = {
    insert: jest.fn().mockResolvedValue({ error: null }),
  };
  const client = {
    from: jest.fn((table: string) => (table === 'cash_balances' ? balanceChain : ledgerChain)),
  };
  return { supabase: { getClient: jest.fn().mockReturnValue(client) }, balanceChain, ledgerChain };
}

describe('CashLedgerService', () => {
  describe('record', () => {
    it('credits settled on settlement_credit', async () => {
      const { supabase, ledgerChain, balanceChain } = buildSupabase({
        id: 'b1', user_id: 'u1', destination_id: 'd1', currency: 'EUR',
        settled: '100', pending_in: '0', reserved: '0',
      });
      const svc = new CashLedgerService(supabase as any);
      await svc.record({
        userId: 'u1', destinationId: 'd1', currency: 'EUR',
        movementType: 'settlement_credit', amount: '250',
      });

      const ledgerInsert = (ledgerChain.insert as jest.Mock).mock.calls[0][0];
      expect(ledgerInsert.movement_type).toBe('settlement_credit');
      expect(ledgerInsert.amount).toBe('250');
      expect(ledgerInsert.balance_after).toMatch(/^350\.0+$/);

      const upsert = (balanceChain.upsert as jest.Mock).mock.calls[0][0];
      expect(upsert.settled).toMatch(/^350\.0+$/);
    });

    it('debits settled on settlement_debit (signed negative amount)', async () => {
      const { supabase, balanceChain } = buildSupabase({
        id: 'b1', user_id: 'u1', destination_id: 'd1', currency: 'EUR',
        settled: '1000', pending_in: '0', reserved: '0',
      });
      const svc = new CashLedgerService(supabase as any);
      await svc.record({
        userId: 'u1', destinationId: 'd1', currency: 'EUR',
        movementType: 'settlement_debit', amount: '-300',
      });
      const upsert = (balanceChain.upsert as jest.Mock).mock.calls[0][0];
      expect(upsert.settled).toMatch(/^700\.0+$/);
    });

    it('refuses to let settled go negative', async () => {
      const { supabase } = buildSupabase({
        id: 'b1', user_id: 'u1', destination_id: 'd1', currency: 'EUR',
        settled: '50', pending_in: '0', reserved: '0',
      });
      const svc = new CashLedgerService(supabase as any);
      await expect(
        svc.record({
          userId: 'u1', destinationId: 'd1', currency: 'EUR',
          movementType: 'settlement_debit', amount: '-100',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('reservation increments reserved (not settled)', async () => {
      const { supabase, balanceChain } = buildSupabase({
        id: 'b1', user_id: 'u1', destination_id: 'd1', currency: 'EUR',
        settled: '1000', pending_in: '0', reserved: '0',
      });
      const svc = new CashLedgerService(supabase as any);
      await svc.record({
        userId: 'u1', destinationId: 'd1', currency: 'EUR',
        movementType: 'reservation', amount: '200',
      });
      const upsert = (balanceChain.upsert as jest.Mock).mock.calls[0][0];
      expect(upsert.settled).toMatch(/^1000\.0+$/);
      expect(upsert.reserved).toMatch(/^200\.0+$/);
    });

    it('reservation_release decrements reserved', async () => {
      const { supabase, balanceChain } = buildSupabase({
        id: 'b1', user_id: 'u1', destination_id: 'd1', currency: 'EUR',
        settled: '1000', pending_in: '0', reserved: '200',
      });
      const svc = new CashLedgerService(supabase as any);
      await svc.record({
        userId: 'u1', destinationId: 'd1', currency: 'EUR',
        movementType: 'reservation_release', amount: '200',
      });
      const upsert = (balanceChain.upsert as jest.Mock).mock.calls[0][0];
      expect(upsert.reserved).toMatch(/^0\.0+$/);
    });

    it('rejects reservation_release larger than reserved', async () => {
      const { supabase } = buildSupabase({
        id: 'b1', user_id: 'u1', destination_id: 'd1', currency: 'EUR',
        settled: '1000', pending_in: '0', reserved: '50',
      });
      const svc = new CashLedgerService(supabase as any);
      await expect(
        svc.record({
          userId: 'u1', destinationId: 'd1', currency: 'EUR',
          movementType: 'reservation_release', amount: '100',
        }),
      ).rejects.toThrow('Libération supérieure');
    });

    it('initialises a zero balance row on first touch', async () => {
      const { supabase, balanceChain } = buildSupabase(null);
      const svc = new CashLedgerService(supabase as any);
      await svc.record({
        userId: 'u1', destinationId: 'd-new', currency: 'EUR',
        movementType: 'deposit', amount: '500',
      });
      const upsert = (balanceChain.upsert as jest.Mock).mock.calls[0][0];
      expect(upsert.settled).toMatch(/^500\.0+$/);
      expect(upsert.reserved).toMatch(/^0\.0+$/);
    });
  });

  describe('adjustPendingIn', () => {
    it('bumps pending_in by a positive delta', async () => {
      const { supabase, balanceChain } = buildSupabase({
        id: 'b1', user_id: 'u1', destination_id: 'd1', currency: 'EUR',
        settled: '0', pending_in: '100', reserved: '0',
      });
      const svc = new CashLedgerService(supabase as any);
      await svc.adjustPendingIn('u1', 'd1', 'EUR', '300');
      const upsert = (balanceChain.upsert as jest.Mock).mock.calls[0][0];
      expect(upsert.pending_in).toMatch(/^400\.0+$/);
    });

    it('floors pending_in at 0 on large negative adjustments', async () => {
      const { supabase, balanceChain } = buildSupabase({
        id: 'b1', user_id: 'u1', destination_id: 'd1', currency: 'EUR',
        settled: '0', pending_in: '100', reserved: '0',
      });
      const svc = new CashLedgerService(supabase as any);
      await svc.adjustPendingIn('u1', 'd1', 'EUR', '-500');
      const upsert = (balanceChain.upsert as jest.Mock).mock.calls[0][0];
      expect(upsert.pending_in).toMatch(/^0\.0+$/);
    });
  });
});
