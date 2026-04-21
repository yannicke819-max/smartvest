import { DriftSource } from '../services/sources/drift.source';

function makeSupabase(snapshotData: unknown, profileData: unknown) {
  const profileChain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: profileData, error: null }),
  };
  const snapshotChain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: snapshotData, error: null }),
  };
  const client = {
    from: jest.fn((table: string) => (table === 'user_profiles' ? profileChain : snapshotChain)),
  };
  return { getClient: jest.fn().mockReturnValue(client) };
}

describe('DriftSource', () => {
  it('returns empty array when no snapshot found', async () => {
    const svc = new DriftSource(makeSupabase(null, null) as any);
    const result = await svc.detect('pf1', 'u1');
    expect(result).toEqual([]);
  });

  it('returns empty array when allocation_snapshot is null', async () => {
    const svc = new DriftSource(makeSupabase({ allocation_snapshot: null }, null) as any);
    const result = await svc.detect('pf1', 'u1');
    expect(result).toEqual([]);
  });

  it('generates drift proposal when allocation deviates beyond threshold', async () => {
    // equilibre template: etf 50%, bond 35%, cash 15%
    // Give etf=0.70 → drift = (0.70 - 0.50) * 100 = 20, surexposé — needsRebalance = true (>5)
    const snapshot = { allocation_snapshot: { etf: 0.7, bond: 0.35, cash: 0.15 } };
    const svc = new DriftSource(makeSupabase(snapshot, { risk_profile: 'equilibre' }) as any);
    const proposals = await svc.detect('pf1', 'u1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.sourceKind).toBe('drift');
    expect(proposals[0]!.action).toBe('rebalance');
    expect(proposals[0]!.assetClass).toBe('etf');
    expect(proposals[0]!.dedupKey).toBe('drift:pf1:etf');
  });

  it('assigns score 0.75 for drift > 20 ppt', async () => {
    // dynamique: etf 70%, bond 20%, cash 10%
    // Give etf=0.92 → drift = (0.92 - 0.70)*100 = 22
    const snapshot = { allocation_snapshot: { etf: 0.92, bond: 0.20, cash: 0.10 } };
    const svc = new DriftSource(makeSupabase(snapshot, { risk_profile: 'dynamique' }) as any);
    const proposals = await svc.detect('pf1', 'u1');
    const etfProposal = proposals.find((p) => p.assetClass === 'etf');
    expect(etfProposal!.score).toBe(0.75);
  });

  it('assigns score 0.65 for drift between 10 and 20 ppt', async () => {
    // equilibre: etf 50%, bond 35%, cash 15%
    // Give etf=0.63 → drift = (0.63 - 0.50)*100 = 13
    const snapshot = { allocation_snapshot: { etf: 0.63, bond: 0.35, cash: 0.15 } };
    const svc = new DriftSource(makeSupabase(snapshot, { risk_profile: 'equilibre' }) as any);
    const proposals = await svc.detect('pf1', 'u1');
    const etfProposal = proposals.find((p) => p.assetClass === 'etf');
    expect(etfProposal!.score).toBe(0.65);
  });

  it('assigns score 0.45 for drift between 5 and 10 ppt', async () => {
    // equilibre: etf 50%, bond 35%, cash 15%
    // Give etf=0.57 → drift = (0.57 - 0.50)*100 = 7
    const snapshot = { allocation_snapshot: { etf: 0.57, bond: 0.35, cash: 0.15 } };
    const svc = new DriftSource(makeSupabase(snapshot, { risk_profile: 'equilibre' }) as any);
    const proposals = await svc.detect('pf1', 'u1');
    const etfProposal = proposals.find((p) => p.assetClass === 'etf');
    expect(etfProposal!.score).toBe(0.45);
  });

  it('returns no proposals when allocation is within threshold', async () => {
    // equilibre: etf 50%, bond 35%, cash 15% — all within ±5ppt
    const snapshot = { allocation_snapshot: { etf: 0.51, bond: 0.36, cash: 0.15 } };
    const svc = new DriftSource(makeSupabase(snapshot, { risk_profile: 'equilibre' }) as any);
    const proposals = await svc.detect('pf1', 'u1');
    expect(proposals).toHaveLength(0);
  });

  it('defaults to equilibre profile when risk_profile is null', async () => {
    // equilibre: etf 50% — give etf=0.72, drift=22 → score 0.75
    const snapshot = { allocation_snapshot: { etf: 0.72, bond: 0.35, cash: 0.15 } };
    const svc = new DriftSource(makeSupabase(snapshot, { risk_profile: null }) as any);
    const proposals = await svc.detect('pf1', 'u1');
    expect(proposals.length).toBeGreaterThan(0);
  });
});
