// Mock FeatureFlagsService to avoid resolving @smartvest/shared-types (broken moduleNameMapper path)
jest.mock('../../feature-flags/feature-flags.service', () => ({
  FeatureFlagsService: jest.fn().mockImplementation(() => ({ isEnabled: jest.fn().mockReturnValue(true) })),
}));

import { ProposalGeneratorService } from '../services/proposal-generator.service';
import type { RawProposal } from '../interfaces/raw-proposal';

function makeRaw(overrides: Partial<RawProposal> = {}): RawProposal {
  return {
    action: 'rebalance',
    currency: 'EUR',
    rationale: 'test rationale',
    assumptions: [],
    sourceKind: 'drift',
    score: 0.6,
    expiresInDays: 7,
    dedupKey: `key:${Math.random()}`,
    ...overrides,
  };
}

function buildSupabaseMock(opts: {
  mandate?: Record<string, unknown> | null;
  dupCount?: number;
}) {
  const mandateChain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: opts.mandate ?? null, error: null }),
  };

  const auditSelectChain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
  };

  const dupChain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    gte: jest.fn().mockResolvedValue({ count: opts.dupCount ?? 0, error: null }),
  };

  const insertChain = {
    insert: jest.fn().mockResolvedValue({ error: null }),
  };

  const client = {
    from: jest.fn((table: string) => {
      if (table === 'autonomy_mandates') return mandateChain;
      if (table === 'autonomy_audit_events') return { ...auditSelectChain, ...insertChain };
      if (table === 'action_proposals') return { ...dupChain, ...insertChain };
      return { select: jest.fn().mockReturnThis(), insert: jest.fn().mockResolvedValue({ error: null }) };
    }),
  };

  return { getClient: jest.fn().mockReturnValue(client) };
}

function buildFlags(enabled: boolean) {
  return { isEnabled: jest.fn().mockReturnValue(enabled) };
}

function buildScorer(opts: {
  allowed?: RawProposal[];
  blocked?: Array<{ proposal: RawProposal; reason: string }>;
} = {}) {
  return {
    applyGuardrails: jest.fn().mockReturnValue({
      allowed: opts.allowed ?? [],
      blocked: opts.blocked ?? [],
    }),
    rankAndDedup: jest.fn().mockImplementation((p: RawProposal[]) => p),
    dedupWindowDays: jest.fn().mockReturnValue(7),
  };
}

function buildSources(proposals: RawProposal[] = []) {
  const src = { detect: jest.fn().mockResolvedValue(proposals) };
  return src;
}

function buildFriction() {
  return { estimate: jest.fn().mockReturnValue(null) };
}

function makeService(opts: {
  flagEnabled?: boolean;
  mandate?: Record<string, unknown> | null;
  rawProposals?: RawProposal[];
  allowed?: RawProposal[];
  blocked?: Array<{ proposal: RawProposal; reason: string }>;
  dupCount?: number;
}) {
  const supabase = buildSupabaseMock({
    ...(opts.mandate !== undefined ? { mandate: opts.mandate } : {}),
    ...(opts.dupCount !== undefined ? { dupCount: opts.dupCount } : {}),
  });
  const flags = buildFlags(opts.flagEnabled ?? true);
  const proposals = opts.rawProposals ?? [];
  const scorer = buildScorer({ allowed: opts.allowed ?? proposals, blocked: opts.blocked ?? [] });
  const src = buildSources(proposals);
  const friction = buildFriction();

  return new ProposalGeneratorService(
    supabase as any,
    flags as any,
    scorer as any,
    friction as any,
    src as any, // drift
    src as any, // concentration
    src as any, // goalTrigger
    src as any, // macroSignal
    src as any, // performance
  );
}

describe('ProposalGeneratorService', () => {
  describe('feature flag disabled', () => {
    it('returns flag_disabled reason without running sources', async () => {
      const svc = makeService({ flagEnabled: false });
      const result = await svc.generateForPortfolio('pf1', 'u1');
      expect(result.reason).toBe('flag_disabled');
      expect(result.generated).toBe(0);
    });
  });

  describe('kill switch active', () => {
    it('returns kill_switch_active when mandate has kill_switch_active=true', async () => {
      const svc = makeService({
        mandate: { id: 'm1', kill_switch_active: true, status: 'active', forbidden_tickers: [], allowed_asset_classes: [] },
      });
      const result = await svc.generateForPortfolio('pf1', 'u1');
      expect(result.reason).toBe('kill_switch_active');
      expect(result.generated).toBe(0);
    });
  });

  describe('normal generation', () => {
    it('returns generated=0 when no proposals pass guardrails', async () => {
      const svc = makeService({ rawProposals: [], allowed: [] });
      const result = await svc.generateForPortfolio('pf1', 'u1');
      expect(result.generated).toBe(0);
      expect(result.proposalIds).toHaveLength(0);
    });

    it('persists proposals and returns their ids', async () => {
      const proposals = [
        makeRaw({ score: 0.8, dedupKey: 'k1' }),
        makeRaw({ score: 0.6, dedupKey: 'k2' }),
      ];
      const svc = makeService({ rawProposals: proposals, allowed: proposals, dupCount: 0 });
      const result = await svc.generateForPortfolio('pf1', 'u1');
      expect(result.generated).toBe(2);
      expect(result.proposalIds).toHaveLength(2);
      expect(result.blocked).toBe(0);
    });

    it('counts blocked proposals in result', async () => {
      const blockedP = makeRaw({ dedupKey: 'k-blocked' });
      const allowedP = makeRaw({ dedupKey: 'k-allowed' });
      const svc = makeService({
        rawProposals: [blockedP, allowedP],
        allowed: [allowedP],
        blocked: [{ proposal: blockedP, reason: 'kill_switch_active' }],
        dupCount: 0,
      });
      const result = await svc.generateForPortfolio('pf1', 'u1');
      expect(result.generated).toBe(1);
      expect(result.blocked).toBe(1);
    });

    it('skips duplicate proposals detected in DB', async () => {
      const proposals = [makeRaw({ dedupKey: 'dup-key' })];
      const svc = makeService({ rawProposals: proposals, allowed: proposals, dupCount: 1 });
      const result = await svc.generateForPortfolio('pf1', 'u1');
      expect(result.generated).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('caps output at MAX_PROPOSALS_PER_RUN (5)', async () => {
      const proposals = Array.from({ length: 8 }, (_, i) =>
        makeRaw({ score: (8 - i) / 10, dedupKey: `k${i}` }),
      );
      const svc = makeService({ rawProposals: proposals, allowed: proposals, dupCount: 0 });
      const result = await svc.generateForPortfolio('pf1', 'u1');
      expect(result.generated).toBeLessThanOrEqual(5);
      expect(result.skipped).toBeGreaterThanOrEqual(3);
    });

    it('works without a mandate (null)', async () => {
      const proposals = [makeRaw({ dedupKey: 'k1' })];
      const svc = makeService({ mandate: null, rawProposals: proposals, allowed: proposals, dupCount: 0 });
      const result = await svc.generateForPortfolio('pf1', 'u1');
      expect(result.generated).toBe(1);
    });
  });
});
