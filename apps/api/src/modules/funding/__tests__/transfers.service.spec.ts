import { ConflictException, NotFoundException } from '@nestjs/common';
import { TransfersService } from '../services/transfers.service';

function chainMock(single?: unknown) {
  const chain: Record<string, jest.Mock> = {};
  chain['select'] = jest.fn().mockReturnValue(chain);
  chain['eq'] = jest.fn().mockReturnValue(chain);
  chain['order'] = jest.fn().mockReturnValue(chain);
  chain['limit'] = jest.fn().mockResolvedValue({ data: [], error: null });
  chain['insert'] = jest.fn().mockResolvedValue({ error: null });
  chain['update'] = jest.fn().mockReturnValue({
    eq: jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    }),
  });
  chain['single'] = jest.fn().mockResolvedValue({ data: single, error: null });
  chain['maybeSingle'] = jest.fn().mockResolvedValue({ data: single, error: null });
  return chain;
}

function buildSupabase(perTable: Record<string, unknown>) {
  const client = {
    from: jest.fn((table: string) => {
      const seed = (perTable[table] as Record<string, unknown> | undefined) ?? {};
      return { ...chainMock(seed['single']), ...(seed as object) };
    }),
  };
  return { getClient: jest.fn().mockReturnValue(client) };
}

function buildAudit() {
  return { write: jest.fn().mockResolvedValue('audit-id'), listForTransfer: jest.fn().mockResolvedValue([]) };
}

describe('TransfersService', () => {
  describe('create', () => {
    it('creates a draft transfer when destination is valid', async () => {
      const destChain = chainMock({ id: 'dest-1', currency: 'EUR' });
      const transferChain = chainMock({
        id: 'new-id', user_id: 'u1', status: 'draft', destination_id: 'dest-1',
        currency: 'EUR', requested_amount: '1000.00', settled_amount: '0',
      });
      const supabase = buildSupabase({
        funding_destinations: destChain,
        funding_transfers: transferChain,
      });
      const audit = buildAudit();
      const svc = new TransfersService(supabase as any, audit as any);

      const result = await svc.create('u1', {
        destinationId: 'dest-1',
        method: 'bank_transfer',
        currency: 'EUR',
        requestedAmount: '1000.00',
      });

      expect(result.status).toBe('draft');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'transfer_created', newStatus: 'draft' }),
      );
    });

    it('throws when destination does not belong to user', async () => {
      const destChain = chainMock(null); // destination not found
      const supabase = buildSupabase({ funding_destinations: destChain });
      const svc = new TransfersService(supabase as any, buildAudit() as any);

      await expect(
        svc.create('u1', {
          destinationId: 'dest-X',
          method: 'bank_transfer',
          currency: 'EUR',
          requestedAmount: '1000.00',
        }),
      ).rejects.toThrow('Destination introuvable');
    });

    it('writes an allocation_linked audit when linkGoalId is passed', async () => {
      const destChain = chainMock({ id: 'dest-1', currency: 'EUR' });
      const transferChain = chainMock({
        id: 'new-id', status: 'draft', destination_id: 'dest-1',
        currency: 'EUR', requested_amount: '500.00', settled_amount: '0',
      });
      const linkChain = chainMock({});
      const supabase = buildSupabase({
        funding_destinations: destChain,
        funding_transfers: transferChain,
        funding_allocation_links: linkChain,
      });
      const audit = buildAudit();
      const svc = new TransfersService(supabase as any, audit as any);

      await svc.create('u1', {
        destinationId: 'dest-1',
        method: 'bank_transfer',
        currency: 'EUR',
        requestedAmount: '500.00',
        linkGoalId: 'goal-1',
      });

      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ kind: 'transfer_created' }));
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ kind: 'allocation_linked' }));
    });
  });

  describe('transitions', () => {
    function makeSvcWith(transferData: Record<string, unknown>) {
      const transferChain = chainMock(transferData);
      const supabase = buildSupabase({ funding_transfers: transferChain });
      const audit = buildAudit();
      return { svc: new TransfersService(supabase as any, audit as any), audit };
    }

    it('allows draft → initiated', async () => {
      const { svc, audit } = makeSvcWith({
        id: 't1', status: 'draft', requested_amount: '1000', currency: 'EUR',
      });
      await svc.initiate('t1', 'u1');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'transfer_initiated', prevStatus: 'draft', newStatus: 'initiated' }),
      );
    });

    it('blocks cancelled → settled (invalid transition)', async () => {
      const { svc } = makeSvcWith({ id: 't1', status: 'cancelled', requested_amount: '1000', currency: 'EUR' });
      await expect(svc.settle('t1', 'u1', {})).rejects.toThrow(ConflictException);
    });

    it('blocks settled → initiated', async () => {
      const { svc } = makeSvcWith({ id: 't1', status: 'settled', requested_amount: '1000', currency: 'EUR' });
      await expect(svc.initiate('t1', 'u1')).rejects.toThrow(ConflictException);
    });

    it('allows settled → reversed (with reason)', async () => {
      const { svc, audit } = makeSvcWith({ id: 't1', status: 'settled', requested_amount: '1000', currency: 'EUR' });
      await svc.reverse('t1', 'u1', { reason: 'erreur de saisie' });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'transfer_reversed', reason: 'erreur de saisie' }),
      );
    });

    it('settle with partial amount transitions to partially_settled', async () => {
      const { svc, audit } = makeSvcWith({
        id: 't1', status: 'pending_settlement', requested_amount: '1000', currency: 'EUR',
      });
      await svc.settle('t1', 'u1', { settledAmount: '400' });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'transfer_partially_settled', newStatus: 'partially_settled' }),
      );
    });

    it('settle with full amount transitions to settled', async () => {
      const { svc, audit } = makeSvcWith({
        id: 't1', status: 'pending_settlement', requested_amount: '1000', currency: 'EUR',
      });
      await svc.settle('t1', 'u1', { settledAmount: '1000' });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'transfer_settled', newStatus: 'settled' }),
      );
    });

    it('rejects settledAmount > requestedAmount', async () => {
      const { svc } = makeSvcWith({
        id: 't1', status: 'initiated', requested_amount: '1000', currency: 'EUR',
      });
      await expect(svc.settle('t1', 'u1', { settledAmount: '1500' })).rejects.toThrow(
        'settledAmount ne peut dépasser',
      );
    });

    it('rejects settledAmount <= 0', async () => {
      const { svc } = makeSvcWith({
        id: 't1', status: 'initiated', requested_amount: '1000', currency: 'EUR',
      });
      await expect(svc.settle('t1', 'u1', { settledAmount: '0' })).rejects.toThrow('settledAmount invalide');
    });

    it('fail requires a reason and writes failure_reason', async () => {
      const { svc, audit } = makeSvcWith({
        id: 't1', status: 'initiated', requested_amount: '1000', currency: 'EUR',
      });
      await svc.fail('t1', 'u1', { reason: 'banque a refusé' });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'transfer_failed', reason: 'banque a refusé' }),
      );
    });
  });

  describe('update', () => {
    it('allows PATCH on a draft transfer', async () => {
      const transferChain = chainMock({
        id: 't1', status: 'draft', requested_amount: '1000', currency: 'EUR',
      });
      const supabase = buildSupabase({ funding_transfers: transferChain });
      const svc = new TransfersService(supabase as any, buildAudit() as any);
      const result = await svc.update('t1', 'u1', { note: 'corrigé' });
      expect(result.status).toBe('draft');
    });

    it('refuses PATCH on a non-draft transfer', async () => {
      const transferChain = chainMock({ id: 't1', status: 'initiated' });
      const supabase = buildSupabase({ funding_transfers: transferChain });
      const svc = new TransfersService(supabase as any, buildAudit() as any);
      await expect(svc.update('t1', 'u1', { note: 'x' })).rejects.toThrow(ConflictException);
    });
  });

  describe('get', () => {
    it('throws NotFoundException when the transfer does not exist', async () => {
      const transferChain = chainMock(null);
      transferChain['single'] = jest.fn().mockResolvedValue({ data: null, error: { message: 'not found' } });
      const supabase = buildSupabase({ funding_transfers: transferChain });
      const svc = new TransfersService(supabase as any, buildAudit() as any);
      await expect(svc.get('t1', 'u1')).rejects.toThrow(NotFoundException);
    });
  });
});
