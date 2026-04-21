import { FundingAuditService } from '../services/funding-audit.service';

function buildSupabase(prevHash: string | null) {
  const selectChain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: prevHash ? { hash: prevHash } : null, error: null }),
    insert: jest.fn().mockResolvedValue({ error: null }),
  };
  const client = { from: jest.fn(() => selectChain) };
  return { supabase: { getClient: jest.fn().mockReturnValue(client) }, chain: selectChain };
}

describe('FundingAuditService', () => {
  it('writes a sha256 hash chained off the previous event', async () => {
    const { supabase, chain } = buildSupabase(null);
    const svc = new FundingAuditService(supabase as any);

    const id = await svc.write({
      userId: 'u1',
      kind: 'transfer_created',
      transferId: 't1',
      reason: 'initial',
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const insertCall = (chain.insert as jest.Mock).mock.calls[0][0];
    expect(insertCall.hash).toHaveLength(64); // sha256 hex
    expect(insertCall.prev_hash).toBeNull();
  });

  it('chains the new event onto the previous hash', async () => {
    const prevHash = 'a'.repeat(64);
    const { supabase, chain } = buildSupabase(prevHash);
    const svc = new FundingAuditService(supabase as any);

    await svc.write({ userId: 'u1', kind: 'transfer_settled', reason: 'ok' });

    const inserted = (chain.insert as jest.Mock).mock.calls[0][0];
    expect(inserted.prev_hash).toBe(prevHash);
    expect(inserted.hash).not.toBe(prevHash);
  });

  it('produces different hashes for different reasons even when userId + kind match', async () => {
    const { supabase: s1, chain: c1 } = buildSupabase(null);
    const { supabase: s2, chain: c2 } = buildSupabase(null);
    const svc1 = new FundingAuditService(s1 as any);
    const svc2 = new FundingAuditService(s2 as any);

    await svc1.write({ userId: 'u1', kind: 'transfer_created', reason: 'A' });
    await svc2.write({ userId: 'u1', kind: 'transfer_created', reason: 'B' });

    const h1 = (c1.insert as jest.Mock).mock.calls[0][0].hash;
    const h2 = (c2.insert as jest.Mock).mock.calls[0][0].hash;
    expect(h1).not.toBe(h2);
  });
});
